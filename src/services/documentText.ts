/** Extract document text without importing executable code or styles as lyrics.
 * Shared by HTML format detection and the line-classification import path. */
export function extractDocumentText(element: Element): string {
  if (["script", "style"].includes(element.tagName.toLowerCase())) return "";
  let text = "";
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) text += node.textContent ?? "";
    else if (node.nodeType === 1) {
      const child = node as Element;
      const tag = child.tagName.toLowerCase();
      if (["script", "style"].includes(tag)) continue;
      text += extractDocumentText(child);
      if (["p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "li"].includes(tag)) text += "\n";
    }
  }
  return text;
}
