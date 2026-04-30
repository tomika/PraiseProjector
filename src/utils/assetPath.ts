/**
 * Get the correct asset path based on the current environment
 * In development: /assets/filename.png (for dev server) or ./assets/filename.png (for built Electron)
 * In production: /webapp/assets/filename.png (web) or ./assets/filename.png (Electron)
 */
export function getAssetPath(path: string): string {
  // Ensure path starts with /
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  // In Electron mode, check if we're loading from dev server or built files
  if (typeof window !== "undefined" && (window as { electron?: unknown }).electron) {
    // If we're loading from localhost (dev server), use absolute paths
    if (window.location.protocol === "http:" && window.location.hostname === "localhost") {
      return normalizedPath; // /assets/image.png
    }
    // Otherwise use relative paths for built Electron app
    return `.${normalizedPath}`; // ./assets/image.png
  }

  // In web mode, use BASE_URL
  const baseUrl = import.meta.env.BASE_URL || "/";

  // Remove leading slash from path since BASE_URL already has trailing slash
  const pathWithoutLeadingSlash = normalizedPath.substring(1);

  return `${baseUrl}${pathWithoutLeadingSlash}`;
}
