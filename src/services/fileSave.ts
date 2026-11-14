/** "cancelled": the user closed the save dialog or document picker. */
export type FileSaveResult = "saved" | "cancelled";

/** The runtime cannot save files at all: an Android APK predating the file save
 * bridge. Callers show the localized `FileSaveUnsupported` text. */
export class FileSaveUnsupportedError extends Error {
  constructor() {
    super("This app version cannot save files; update the app");
    this.name = "FileSaveUnsupportedError";
  }
}

/** Raw bytes per bridge call (1 MiB of base64). */
const CHUNK_BYTES = 768 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

type NativeSaveOutcome = { id?: unknown; result?: unknown; message?: unknown };

/**
 * Saves generated content as a file the user keeps, in every runtime:
 * - Electron: the native save dialog (`saveDatabaseFile`).
 * - Android: the system document picker. A WebView ignores `<a download>`, so
 *   the bytes go through the host's file save bridge.
 * - Browser/PWA: an ordinary download, which cannot report its outcome
 *   ("saved" means it was handed to the browser).
 * Throws when saving fails, or FileSaveUnsupportedError when the runtime cannot
 * save files at all: never reports a save that did not happen.
 */
export async function saveGeneratedFile(data: Blob, fileName: string): Promise<FileSaveResult> {
  if (window.electronAPI?.saveDatabaseFile) {
    const result = await window.electronAPI.saveDatabaseFile(await data.arrayBuffer(), fileName);
    if (result.success) return "saved";
    if (result.error === "Cancelled") return "cancelled";
    throw new Error(result.error ?? "Save failed");
  }
  const host = window.hostDevice;
  if (host) {
    const { beginFileSave, appendFileSave, commitFileSave, abortFileSave } = host;
    if (!beginFileSave || !appendFileSave || !commitFileSave) throw new FileSaveUnsupportedError();
    const id = await beginFileSave.call(host, fileName, data.type || "application/octet-stream");
    if (!id) throw new Error("Another file is being saved");
    let settle: (outcome: NativeSaveOutcome) => void = () => {};
    const outcome = new Promise<NativeSaveOutcome>((resolve) => {
      settle = resolve;
    });
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<NativeSaveOutcome>).detail;
      if (detail?.id === id) settle(detail);
    };
    // Registered before the picker opens, so the outcome cannot be missed.
    window.addEventListener("pp-file-save-result", listener);
    try {
      try {
        const bytes = new Uint8Array(await data.arrayBuffer());
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          if (!(await appendFileSave.call(host, id, toBase64(bytes.subarray(offset, offset + CHUNK_BYTES))))) throw new Error("Save failed");
        }
        if (!(await commitFileSave.call(host, id))) throw new Error("Save failed");
      } catch (error) {
        await abortFileSave?.call(host, id);
        throw error;
      }
      const { result, message } = await outcome;
      if (result === "saved") return "saved";
      if (result === "cancelled") return "cancelled";
      throw new Error(typeof message === "string" && message ? message : "Save failed");
    } finally {
      window.removeEventListener("pp-file-save-result", listener);
    }
  }
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "saved";
}
