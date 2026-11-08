import assert from "node:assert/strict";
import { test } from "node:test";
import ImportError from "typesense/lib/Typesense/Errors/ImportError";
import { TypesenseClient } from "../typesense-client";

type Doc = { id: string; songId: string; version: number } & Record<string, unknown>;

/** Values of a `field:=[`a`,`b`]` filter, as the client escapes them. */
const filterValues = (filter: string) => [...filter.matchAll(/`((?:\\.|[^`\\])*)`/g)].map((match) => match[1].replace(/\\(.)/g, "$1"));

/** An in-memory stand-in for the typesense-js client: only the calls the index uses. */
function fakeTypesense() {
  const docs = new Map<string, Doc>();
  const fake = {
    docs,
    failImport: new Set<string>(),
    failExports: 0,
    deleteRequests: 0,
    collectionExists: false,
    importDown: false,
  };
  const documents = {
    // Like typesense-js 1.8: any failed document turns the whole call into an
    // ImportError that carries every document's result.
    import: async (batch: Doc[]) => {
      if (fake.importDown) throw new Error("connection refused");
      const results = batch.map((doc) => {
        if (fake.failImport.has(doc.songId)) return { success: false, error: "rejected" };
        docs.set(doc.id, doc);
        return { success: true };
      });
      if (results.some((result) => !result.success)) throw new ImportError("documents failed during import", results);
      return results;
    },
    export: async ({ filter_by }: { filter_by: string }) => {
      if (fake.failExports-- > 0) throw new Error("connection timeout");
      const songIds = filterValues(filter_by);
      return [...docs.values()]
        .filter((doc) => songIds.includes(doc.songId))
        .map((doc) => JSON.stringify({ id: doc.id, songId: doc.songId, version: doc.version }))
        .join("\n");
    },
    delete: async ({ filter_by }: { filter_by: string }) => {
      fake.deleteRequests++;
      return { num_deleted: filterValues(filter_by).filter((id) => docs.delete(id)).length };
    },
  };
  const client = {
    collections: (name?: string) =>
      name
        ? {
            delete: async () => {
              docs.clear();
              fake.collectionExists = false;
            },
            documents: () => documents,
          }
        : { create: async () => (fake.collectionExists = true) },
  };
  const index = new TypesenseClient("localhost", 8108, "http", "key");
  (index as unknown as { client: unknown }).client = client;
  return { index, fake };
}

const song = (id: string, version: number, text = "{title:Song}\nla la") => ({ id, version, text });

test("a failed import is reported, so the song's indexed version is not cleaned up", async () => {
  const { index, fake } = fakeTypesense();
  await index.update([song("a", 1), song("b", 1)]);
  fake.failImport.add("a");
  const failed = await index.update([song("a", 2), song("b", 2)]);
  assert.deepEqual([...failed], ["a"]);
  assert.ok(fake.docs.has("a_1"), "nothing replaced it");
  assert.ok(fake.docs.has("b_2"), "the other songs of the batch are indexed");
});

test("song directives cannot overwrite the indexed id or version", async () => {
  const { index, fake } = fakeTypesense();
  await index.update([song("a", 7, "{title:Song}\n{version: 2b}\n{id: other}\nla")]);
  assert.deepEqual([...fake.docs.keys()], ["a_7"]);
  assert.equal(fake.docs.get("a_7")!.version, 7);
});

test("only versions missing from the live set are removed, pending ones kept, one delete per batch", async () => {
  const { index, fake } = fakeTypesense();
  await index.update([song("a", 1), song("a", 2), song("a", 3), song("b", 1)]);
  await index.removeStaleVersions(["a"], new Set(["a_2", "a_3"]));
  assert.deepEqual([...fake.docs.keys()].sort(), ["a_2", "a_3", "b_1"]);
  assert.equal(fake.deleteRequests, 1);
});

test("a failed batch does not stop the cleanup of the following ones", async () => {
  const { index, fake } = fakeTypesense();
  const ids = Array.from({ length: 150 }, (_, i) => `s${i}`);
  await index.update(ids.flatMap((id) => [song(id, 1), song(id, 2)]));
  fake.failExports = 1; // the first batch of 100 songs times out
  await index.removeStaleVersions(ids, new Set(ids.map((id) => `${id}_2`)));
  assert.ok(fake.docs.has("s0_1"), "the failed batch keeps its documents for the next change");
  assert.ok(!fake.docs.has("s149_1"), "the next batch is still cleaned");
});

test("an uninitialized index does not clean up: the next full update rebuilds it", async () => {
  const { index, fake } = fakeTypesense();
  assert.equal(index.isInitialized, false);
  await index.removeStaleVersions(["a"], new Set());
  assert.equal(fake.deleteRequests, 0);
  await index.update([song("a", 1)]);
  assert.equal(index.isInitialized, true);
});

test("a song's old versions stay when its new version failed to import", async () => {
  const { index, fake } = fakeTypesense();
  await index.update([song("a", 1), song("b", 1)]);
  await index.removeStaleVersions(["a", "b"], new Set(["a_2", "b_2"]), new Set(["b"]));
  assert.deepEqual([...fake.docs.keys()].sort(), ["b_1"]);
});

test("a rebuild whose import failed is rebuilt again by the next update", async () => {
  const { index, fake } = fakeTypesense();
  fake.importDown = true;
  await assert.rejects(index.update([song("a", 1), song("b", 1)]), /connection refused/);
  assert.equal(index.isInitialized, false, "an empty collection must not take partial updates");
  fake.importDown = false;
  await index.update([song("a", 1), song("b", 1)]);
  assert.equal(index.isInitialized, true);
  assert.equal(fake.docs.size, 2);
});

test("only imported documents' directives become searched fields", async () => {
  const { index, fake } = fakeTypesense();
  await index.update([song("a", 1, "{title:A}\n{author: Someone}\n{a,b: x}\nla")]);
  fake.failImport.add("b");
  await index.update([song("b", 1, "{title:B}\n{tempo: 90}\nla")]);
  assert.equal((index as unknown as { metaFieldList: string }).metaFieldList, ",author", "a rejected song's field may not exist in the schema");
});

test("an empty update sends no import", async () => {
  const { index, fake } = fakeTypesense();
  let imports = 0;
  const documents = (index as unknown as { client: { collections: (name: string) => { documents: () => { import: unknown } } } }).client
    .collections("ppsongs")
    .documents();
  const original = documents.import as (...args: unknown[]) => unknown;
  documents.import = (...args: unknown[]) => (imports++, original(...args));
  assert.deepEqual([...(await index.update([]))], []);
  assert.equal(imports, 0);
  assert.equal(index.isInitialized, true, "the empty collection exists");
  assert.equal(fake.collectionExists, true);
});
