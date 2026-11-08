import { Client } from "typesense";
import { CollectionCreateSchema } from "typesense/lib/Typesense/Collections";
import { SearchResponseHit } from "typesense/lib/Typesense/Documents";
import { log, logError } from "./pp-log";
import { SongFoundInfo, SongFoundType } from "./pp-types";
import { normalizeSongLanguage } from "./song-language";

const schema: CollectionCreateSchema = {
  name: "ppsongs",
  fields: [
    { name: "language", type: "string", facet: true, optional: true },
    { name: "created", type: "float", optional: true, index: false },
    { name: "uploader", type: "string", optional: true, index: false },
    { name: "owner", type: "string", optional: true, index: false },
    { name: "headEndPos", type: "float", optional: true, index: false },
    { name: ".*", type: "string", index: true },
  ],
};

type DocumentType = {
  songId: string;
  version: number;
  title: string;
  created: number;
  uploader: string;
  owner: string;
  language: string;
  lyrics: string;
  headEndPos: number;
  meta: { [key: string]: string | number };
};

const escapeFilterValue = (value: string) => "`" + value.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";

/** Songs per export filter and documents per delete filter (keeps the request URL short). */
const STALE_VERSION_BATCH = 100;

/** Document fields a song directive ({key: value}, lowercased) must not
 *  overwrite or add to query_by: id + version key the stale-version cleanup,
 *  and the non-text fields cannot be queried. */
const RESERVED_FIELDS = new Set(["id", "version", "lyrics", "created", "uploader", "owner"]);

/** The id of a song version's document, and the key the stale-version cleanup
 *  compares (a live version's key, whatever id an old document still has). */
export function typesenseVersionKey(songId: string, version: number | string): string {
  return `${songId}_${parseInt(version.toString(), 10)}`;
}

export type SongInfo = {
  id: string;
  version: number;
  text: string;
  created?: Date;
  uploader?: string;
  owner?: string;
  language?: string;
};

export class TypesenseClient {
  private client: Client;
  private initialized = false;
  private metaFields = new Set<string>();
  private metaFieldList = "";
  private queryWeights = "3,2";

  constructor(host: string, port: number, protocol: string, apiKey: string) {
    this.client = new Client({
      apiKey,
      nodes: [{ host, port, protocol }],
      // Search is an optional accelerator for a fully local database. Fail fast
      // so a broken Typesense route cannot freeze the normal song picker.
      connectionTimeoutSeconds: 2,
      numRetries: 1,
      retryIntervalSeconds: 0.1,
    });
  }

  static async verifyConnection(url: string | URL, apiKey: string): Promise<string> {
    try {
      if (typeof url === "string") url = new URL(url);
      const client = new TypesenseClient(
        url.hostname,
        parseInt(url.port) || (url.protocol === "https:" ? 443 : 8108),
        url.protocol.replace(":", ""),
        apiKey
      );
      if (!(await client.healthCheck())) return "unhealthy";
      await client.search("*randomstringthatshouldnotmatch*", 1);
      return "";
    } catch (e) {
      console.error("Database", "Typesense connection test failed", e);
      return e instanceof Error ? e.message : String(e);
    }
  }

  async healthCheck(): Promise<boolean> {
    const health = await this.client.health.retrieve();
    return !!health.ok;
  }

  /** False until a first {@link update} has (re)created the collection: until
   *  then a partial update would recreate it with only those songs. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Upserts `songsToIndex`; the first call of an uninitialized client
   *  recreates the collection with exactly these songs. Returns the ids of the
   *  songs whose import failed: their previously indexed versions must stay
   *  searchable. */
  async update(songsToIndex: SongInfo[], selfCheck: boolean = false): Promise<Set<string>> {
    const rebuilding = !this.initialized;
    if (rebuilding) {
      this.metaFields = new Set();

      try {
        await this.client.collections(schema.name).delete();
      } catch (e) {
        logError(`Error deleting schema '${schema.name}'`, e);
      }
      await this.client.collections().create(schema);
      this.initialized = true;
    }

    // Directive fields per document: only an imported document's become query_by fields.
    const metaKeys: string[][] = [];
    const songs = songsToIndex.map((r) => {
      const meta: { [key: string]: string } = {};
      const keys: string[] = [];
      metaKeys.push(keys);
      const lyrics = r.text
        .replace(/^[ \t]*#.*$|\[[^\]]*\]|^[ \t]*{([^:}]+):?(.*)}[ \t]*$/gm, (_g: string, k: string, v: string) => {
          const key = k?.trim().toLowerCase(),
            value = v?.trim();
          if (key && value && !RESERVED_FIELDS.has(key)) {
            meta[key] = value;
            // query_by is a comma-separated list: only plain names can be searched.
            if (key !== "title" && !key.startsWith("start_") && /^[\p{L}\p{N}_-]+$/u.test(key)) keys.push(key);
          }
          return "";
        })
        .replace(/{start_of_grid.*?{end_of_grid}/gs, "")
        .trim();
      let headEndPos = 0;
      for (let j = 0; j < 2; ++j) {
        const endPos = lyrics.indexOf("\n", headEndPos + 1);
        if (endPos >= 0) headEndPos = endPos;
      }
      const version = parseInt(r.version.toString());
      return {
        // Explicit document id: without it Typesense generates a random one, so
        // "upsert" never replaces anything and every incremental re-index adds
        // another copy of the same song version (duplicate search hits).
        id: typesenseVersionKey(r.id, version),
        songId: r.id,
        version,
        title: meta.title ?? "",
        lyrics,
        headEndPos,
        ...meta,
        created: r.created ? r.created.getTime() : 0,
        uploader: r.uploader ?? "",
        owner: r.owner ?? "",
        language: normalizeSongLanguage(r.language),
      };
    });

    // Nothing to import (typesense-js cannot parse the empty reply to an empty import).
    if (!songs.length) return new Set();
    let results: readonly { success: boolean; error?: string }[];
    try {
      results = await this.client.collections(schema.name).documents().import(songs, { action: "upsert" });
    } catch (error) {
      // typesense-js throws an ImportError when any document fails; the other
      // documents were imported, and the per-document results ride on the error.
      const importResults = (error as { importResults?: unknown }).importResults;
      if (!Array.isArray(importResults)) {
        // A rebuild that imported nothing left an empty collection: the next
        // update must rebuild it again rather than add to it partially.
        if (rebuilding) this.initialized = false;
        throw error;
      }
      results = importResults;
    }
    // Import results come back in input order. A rejected document's directive
    // keys may be missing from the schema: querying them would fail every search.
    const failed = new Set<string>();
    results.forEach((res, i) => {
      if (res.success === false) {
        failed.add(songs[i].songId);
        logError(`Error indexing song '${songs[i].songId}'`, res.error);
      } else for (const key of metaKeys[i]) this.metaFields.add(key);
    });
    log("Typesense index updated");
    this.refreshQueryFields();

    if (selfCheck) {
      log("Starting selfcheck...");
      for (const song of songs) {
        if (song.title && !failed.has(song.songId)) {
          const res = await this.search(song.title);
          const ok = res.find((x) => x.songId === song.songId && x.version.toString() === song.version.toString());
          if (!ok) {
            log("SelfCheck Error: Newly registered song not found in typesense: " + song.songId + "(" + song.title + ")");
          }
        }
      }
      log("Selfcheck done.");
    }
    return failed;
  }

  /** Searches title and lyrics first, then every known directive field. */
  private refreshQueryFields() {
    const metaFieldArray = Array.from(this.metaFields);
    this.queryWeights = "3,2";
    if (metaFieldArray.length > 0) {
      this.metaFieldList = "," + metaFieldArray.join(",");
      for (let p = 0, l = this.metaFields.size; p < l; ++p) this.queryWeights += ",1";
    } else this.metaFieldList = "";
  }

  /** Deletes the indexed versions of `songIds` whose {@link typesenseVersionKey}
   *  is not in `liveVersions`. Documents are keyed by song version, so a row
   *  that gets a new version (edit, state change, renumbering) or is archived
   *  would otherwise stay in the index until the next full rebuild, taking up
   *  search hits that are filtered out only afterwards.
   *
   *  `liveVersions` must hold EVERY version of these songs that is to stay
   *  searchable (a song can have several live rows, e.g. pending versions of
   *  different users), read after the indexed versions were written: anything
   *  else indexed for these songs is deleted, except for `keepSongIds` (songs
   *  whose new version failed to import keep their old ones). A failed batch is
   *  logged and the remaining batches are still cleaned. */
  async removeStaleVersions(songIds: readonly string[], liveVersions: ReadonlySet<string>, keepSongIds: ReadonlySet<string> = new Set()) {
    // Not initialized yet: the next update() rebuilds the whole collection.
    if (!this.initialized) return;
    const documents = this.client.collections<DocumentType>(schema.name).documents();
    let removed = 0;
    let failedBatches = 0;
    for (let i = 0; i < songIds.length; i += STALE_VERSION_BATCH) {
      try {
        const batch = songIds.slice(i, i + STALE_VERSION_BATCH);
        const exported = await documents.export({
          filter_by: `songId:=[${batch.map(escapeFilterValue).join(",")}]`,
          include_fields: "id,songId,version",
        });
        const stale: string[] = [];
        for (const line of exported.split("\n")) {
          if (!line.trim()) continue;
          const doc = JSON.parse(line) as { id: string; songId: string; version: string | number };
          if (!keepSongIds.has(doc.songId) && !liveVersions.has(typesenseVersionKey(doc.songId, doc.version))) stale.push(doc.id);
        }
        // One request per batch instead of one per document: the server's
        // Typesense writes run one after another behind this cleanup.
        for (let j = 0; j < stale.length; j += STALE_VERSION_BATCH) {
          const ids = stale.slice(j, j + STALE_VERSION_BATCH).map(escapeFilterValue);
          removed += (await documents.delete({ filter_by: `id:=[${ids.join(",")}]` })).num_deleted;
        }
      } catch (error) {
        ++failedBatches;
        logError("Typesense: removing stale song versions failed for a batch", error);
      }
    }
    if (removed) log(`Typesense: ${removed} stale song version(s) removed`);
    if (failedBatches) log(`Typesense: ${failedBatches} stale-version batch(es) failed; those songs are cleaned with their next change`);
  }

  async search(query: string, limit?: number, songIds?: string[], languages?: readonly string[]): Promise<(SongFoundInfo & { version: number })[]> {
    const searchParameters = {
      q: query,
      query_by: "title,lyrics" + this.metaFieldList,
      prioritize_token_position: true,
      limit_hits: limit,
      per_page: limit,
      query_by_weights: this.queryWeights,
      order_by: "_text_match:desc",
      ...(songIds?.length || languages?.length
        ? {
            filter_by: [
              songIds?.length ? `songId:=[${songIds.map(escapeFilterValue).join(",")}]` : "",
              languages?.length ? `language:=[${languages.map(escapeFilterValue).join(",")}]` : "",
            ]
              .filter(Boolean)
              .join(" && "),
          }
        : {}),
    };
    const res = await this.client.collections<DocumentType>(schema.name).documents().search(searchParameters);
    const decodeType = (document: DocumentType, fieldName: string, matches: string[] | string[][]): SongFoundType => {
      switch (fieldName) {
        case "title":
          return "TITLE";
        case "lyrics":
          for (const m of matches) if (typeof m === "string" && document.lyrics.indexOf(m) < document.headEndPos) return "HEAD";
          return "LYRICS";
        default:
          return "META";
      }
    };
    const typeCost = (type: SongFoundType) => {
      switch (type) {
        case "TITLE":
          return 0;
        case "HEAD":
          return 1;
        case "LYRICS":
          return 2;
        case "META":
          return 3;
        default:
          return 4;
      }
    };
    const processHit = (hit: SearchResponseHit<DocumentType>, baseCost: number) => {
      const found: { type: SongFoundType; cost: number; snippet?: string } = {
        type: "LYRICS",
        cost: baseCost,
      };
      let bestHighlight, bestHighlightType;
      let bestHighlightCost = Number.MAX_VALUE;
      for (const highlight of hit.highlights ?? []) {
        const type = decodeType(hit.document, highlight.field, highlight.matched_tokens);
        const tc = typeCost(type) * 1000 + baseCost;
        if (bestHighlightCost === Number.MAX_VALUE || tc < bestHighlightCost) {
          bestHighlightType = type;
          bestHighlightCost = tc;
          bestHighlight = highlight;
        }
      }
      if (bestHighlight && bestHighlightType) {
        found.type = bestHighlightType;
        found.snippet = bestHighlight.snippet;
        if (found.snippet) {
          const firstMark = found.snippet.indexOf("<mark>");
          const lastMark = found.snippet.lastIndexOf("</mark>");
          const prevNL = found.snippet.lastIndexOf("\n", firstMark);
          const nextNL = found.snippet.indexOf("\n", lastMark);
          if (nextNL >= 0) found.snippet = found.snippet.substring(0, Math.min(nextNL, lastMark + 32));
          if (prevNL >= 0) found.snippet = found.snippet.substring(Math.max(prevNL, firstMark - 25));
          found.snippet = found.snippet.trim();
        }
        if (found.type === "META") found.snippet = bestHighlight.field + ":" + found.snippet;
      }
      return found;
    };
    let baseCost = 0;
    const formatDate = (value: number) => {
      try {
        return value && !isNaN(value) ? new Date(value).toISOString() : "";
      } catch (error) {
        logError("Problematic date value: " + value + " type: " + typeof value, error);
        return "";
      }
    };
    // Indexes built before documents had explicit ids can still hold copies of the
    // same song version; keep only the best-ranked hit of each.
    const seen = new Set<string>();
    return (res.hits ?? [])
      .map((hit) => ({
        songId: hit.document.songId,
        version: hit.document.version,
        title: hit.document.title,
        language: normalizeSongLanguage(hit.document.language),
        found: processHit(hit, ++baseCost),
        created: formatDate(hit.document.created),
        owner: hit.document.owner,
        uploader: hit.document.uploader,
      }))
      .filter((x) => x.title)
      .sort((a, b) => {
        const cdiff = a.found.cost - b.found.cost;
        return cdiff || a.title.localeCompare(b.title);
      })
      .filter((x) => {
        const key = typesenseVersionKey(x.songId, x.version);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
}
