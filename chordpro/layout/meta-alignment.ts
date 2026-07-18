/**
 * Resolve a requested metadata alignment without allowing centred overflow to
 * hide the beginning of the value.
 */
export function safeMetaAlignment(requested: string, contentWidth: number, availableWidth: number) {
  return requested === "center" && contentWidth > Math.max(0, availableWidth) ? "left" : requested;
}
