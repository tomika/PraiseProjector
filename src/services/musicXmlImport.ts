import type { MusicXmlResult } from "../../musicxml/musicxml-import";

/** Each import owns a worker, so large scores cannot freeze the editor and a
 * failed/timed-out conversion cannot contaminate the next score's state. */
export async function importMusicXml(file: File, signal?: AbortSignal): Promise<MusicXmlResult> {
  if (file.size > 32 * 1024 * 1024) throw new Error("The MusicXML file exceeds the 32 MB import limit.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) throw new DOMException("Import cancelled", "AbortError");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./musicXml.worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(new DOMException("Import cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("MusicXML conversion exceeded the 30 second limit."));
    }, 30000);
    worker.onmessage = (event: MessageEvent<{ result?: MusicXmlResult; error?: string }>) => {
      finish();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "MusicXML conversion failed."));
    };
    worker.onerror = () => {
      finish();
      reject(new Error("Could not start the MusicXML converter."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage({ bytes, name: file.name }, [bytes.buffer]);
  });
}
