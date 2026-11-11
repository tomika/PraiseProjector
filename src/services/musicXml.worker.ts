import { convertMusicXmlData } from "../../musicxml/musicxml-import";

self.onmessage = (event: MessageEvent<{ bytes: Uint8Array; name: string }>) => {
  try {
    self.postMessage({ result: convertMusicXmlData(event.data.bytes, event.data.name) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
