const PAGING_LAYOUT_WIDTH_THRESHOLD = 768;

export function shouldUsePagingLayout(width: number, height: number): boolean {
  return height > width || width < PAGING_LAYOUT_WIDTH_THRESHOLD;
}

export function shouldUsePagingLayoutForOrientation(width: number, orientation: "portrait" | "landscape"): boolean {
  return orientation === "portrait" || width < PAGING_LAYOUT_WIDTH_THRESHOLD;
}
