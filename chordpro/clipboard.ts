const CHORDPRO_MIME = "text/chordpro";
const CHORDPRO_WEB_MIME = "web text/chordpro";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function readText(): Promise<string> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    return navigator.clipboard.readText();
  }
  throw new Error("Clipboard read is not supported in this environment");
}

export async function writeText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard write is not supported in this environment");
}

/**
 * Writes clipboard content with multiple types.
 *
 * Browser note:
 * - Most Chromium builds preserve custom formats only with the `web ` prefix.
 * - `text/chordpro` may be dropped by the platform clipboard bridge.
 */
export async function writeItems(plain: string, chordpro: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    const escaped = escapeHtml(plain).replace(/\n/g, "<br>");
    const html = `<pre>${escaped}</pre>`;

    // Preferred payload: web custom type + common text/html + text/plain.
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([plain], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
          [CHORDPRO_WEB_MIME]: new Blob([chordpro], { type: CHORDPRO_WEB_MIME }),
        }),
      ]);
      return;
    } catch {
      // Try legacy custom MIME if platform/browser supports it.
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([plain], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
            [CHORDPRO_MIME]: new Blob([chordpro], { type: CHORDPRO_MIME }),
          }),
        ]);
        return;
      } catch {
        // Fall back below.
      }
    }
  }

  // Final fallback: plain text only.
  await writeText(plain);
}

/**
 * Reads clipboard content preferring ChordPro custom type, then HTML, then plain text.
 */
export async function readBestText(): Promise<{ text: string; isChordPro: boolean }> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes(CHORDPRO_WEB_MIME)) {
          const blob = await item.getType(CHORDPRO_WEB_MIME);
          return { text: await blob.text(), isChordPro: true };
        }
        if (item.types.includes(CHORDPRO_MIME)) {
          const blob = await item.getType(CHORDPRO_MIME);
          return { text: await blob.text(), isChordPro: true };
        }
        if (item.types.includes("text/html")) {
          const blob = await item.getType("text/html");
          return { text: await blob.text(), isChordPro: false };
        }
        if (item.types.includes("text/plain")) {
          const blob = await item.getType("text/plain");
          return { text: await blob.text(), isChordPro: false };
        }
      }
    } catch (error) {
      console.error("Error reading clipboard items, falling back to readText:", error);
    }
  }

  return { text: await readText(), isChordPro: false };
}
