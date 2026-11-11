import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import { DocumentImporter } from "../DocumentImporter";
import { extractDocumentText } from "../documentText";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("a slower document cannot publish its lines after a newer import", async () => {
  const importer = new DocumentImporter();
  const oldRead = deferred<string>();
  const oldFile = new File([], "old.txt");
  oldFile.text = () => oldRead.promise;
  const oldController = new AbortController();
  const published: string[] = [];
  const oldImport = importer.parseDocument(oldFile, oldController.signal).then(
    (lines) => {
      published.push(lines.get(0)!.text);
    },
    (error) => assert.equal(error.name, "AbortError")
  );

  oldController.abort();
  const fresh = await importer.parseDocument(new File(["New song"], "new.txt"));
  published.push(fresh.get(0)!.text);
  oldRead.resolve("Old song");
  await oldImport;
  assert.deepEqual(published, ["New song"]);
});

test("cancelled DOCX reads stop before parsing obsolete file bytes", async () => {
  const importer = new DocumentImporter();
  const read = deferred<ArrayBuffer>();
  const file = new File([], "old.docx");
  file.arrayBuffer = () => read.promise;
  const controller = new AbortController();
  const result = assert.rejects(importer.parseDocument(file, controller.signal), { name: "AbortError" });
  controller.abort();
  // Invalid DOCX bytes would fail as a ZIP error if parsing were still started.
  read.resolve(new ArrayBuffer(0));
  await result;
});

test("cancelled format detection never returns text for a stale prompt", async () => {
  const read = deferred<string>();
  const file = new File([], "old.txt");
  file.text = () => read.promise;
  const controller = new AbortController();
  const result = assert.rejects(new DocumentImporter().readPlainText(file, controller.signal), { name: "AbortError" });
  controller.abort();
  read.resolve("X:1\nK:C\nC4|");
  await result;
});

test("an already cancelled PDF request does not read or start PDF.js", async () => {
  const file = new File([], "old.pdf");
  file.arrayBuffer = () => {
    throw new Error("obsolete file was read");
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new DocumentImporter().parseDocument(file, controller.signal), { name: "AbortError" });
});

const html =
  "<html><body><style>body { color: red; }</style><h1>Song title</h1><div>First <b>verse</b><script><![CDATA[{title: Fake song}\nX:1\nK:C\nC4|]]></script><br/>Second line</div><section><STYLE>.hidden { display: none; }</STYLE><p>Chorus</p></section></body></html>";

test("HTML extraction skips nested scripts/styles while preserving visible text", () => {
  const body = new XmlDomParser().parseFromString(html, "text/html").getElementsByTagName("body")[0];
  assert.equal(extractDocumentText(body as unknown as Element), "Song title\nFirst verse\nSecond line\nChorus\n");
});

test("HTML detection and line import both use the cleaned document text", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
  // Node has no browser DOM. Use a real XML DOM with the body accessor consumed
  // by DocumentImporter; the fixture is well-formed HTML in both parsers.
  class HtmlParser {
    parseFromString(text: string) {
      const doc = new XmlDomParser().parseFromString(text, "text/html");
      return { body: doc.getElementsByTagName("body")[0] };
    }
  }
  Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: HtmlParser });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "DOMParser", descriptor);
    else Reflect.deleteProperty(globalThis, "DOMParser");
  });
  const importer = new DocumentImporter();
  const file = new File([html], "song.html");
  const plain = await importer.readPlainText(file);
  assert.doesNotMatch(plain, /Fake song|X:1|color:|display:/);
  const lines = await importer.parseDocument(file);
  assert.deepEqual(
    lines.getAll().map((l) => l.text),
    ["Song title", "First verse", "Second line", "Chorus"]
  );
});
