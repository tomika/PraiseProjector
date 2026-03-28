import localforage from "localforage";

/**
 * ImageStorage service - stores imported images in IndexedDB using localForage.
 * Images are stored as base64 data URLs for easy display.
 */

export interface StoredImage {
  id: string;
  name: string;
  dataUrl: string; // base64 data URL
  width: number;
  height: number;
  size: number; // file size in bytes
  mimeType: string;
  dateAdded: number; // timestamp
}

export interface ImageImportOptions {
  convertToJpeg?: boolean;
  resizeImages?: boolean;
  resolutionWidth?: number;
  resolutionHeight?: number;
  fit?: "touchInner" | "touchOuter" | "stretch";
  quality?: number; // 1-100
  onProgress?: (progress: ImageImportProgress) => void;
}

export interface ImageImportProgress {
  processed: number;
  total: number;
  imported: number;
  failed: number;
  currentFileName?: string;
}

// Configure localForage to use IndexedDB for images
const imageStorage = localforage.createInstance({
  name: "PraiseProjector",
  storeName: "images",
  description: "PraiseProjector background images storage",
});

/**
 * Generate a unique ID for an image
 */
function generateImageId(): string {
  return `img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get image dimensions from a data URL
 */
async function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * Convert a File to a base64 data URL
 */
async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function sanitizePositiveInt(value: number | undefined, fallback: number): number {
  const n = Number.isFinite(value) ? Math.round(value as number) : fallback;
  return Math.max(1, n);
}

function clampQualityPercent(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 85;
  }
  return Math.max(1, Math.min(100, Math.round(value as number)));
}

function dataUrlSizeInBytes(dataUrl: string): number {
  const parts = dataUrl.split(",");
  if (parts.length < 2) {
    return 0;
  }
  const base64 = parts[1];
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, (base64.length * 3) / 4 - padding);
}

async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function drawFittedImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  fit: "touchInner" | "touchOuter" | "stretch"
): void {
  if (fit === "stretch") {
    ctx.drawImage(image, 0, 0, width, height);
    return;
  }

  const imageAspect = image.width / image.height;
  const boxAspect = width / height;

  if (fit === "touchOuter") {
    if (imageAspect > boxAspect) {
      const cropWidth = image.height * boxAspect;
      const cropX = (image.width - cropWidth) / 2;
      ctx.drawImage(image, cropX, 0, cropWidth, image.height, 0, 0, width, height);
      return;
    }

    const cropHeight = image.width / boxAspect;
    const cropY = (image.height - cropHeight) / 2;
    ctx.drawImage(image, 0, cropY, image.width, cropHeight, 0, 0, width, height);
    return;
  }

  // touchInner: keep full image with letterboxing if necessary.
  if (imageAspect > boxAspect) {
    const drawWidth = width;
    const drawHeight = width / imageAspect;
    const y = (height - drawHeight) / 2;
    ctx.drawImage(image, 0, y, drawWidth, drawHeight);
    return;
  }

  const drawWidth = height * imageAspect;
  const x = (width - drawWidth) / 2;
  ctx.drawImage(image, x, 0, drawWidth, height);
}

function fileNameWithoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

async function processImageWithCanvas(
  file: File,
  options: Required<Pick<ImageImportOptions, "convertToJpeg" | "resizeImages" | "resolutionWidth" | "resolutionHeight" | "fit" | "quality">>
): Promise<{ dataUrl: string; width: number; height: number; size: number; mimeType: string; name: string }> {
  const sourceDataUrl = await fileToDataUrl(file);
  const sourceImage = await loadImageFromDataUrl(sourceDataUrl);

  const width = options.resizeImages ? sanitizePositiveInt(options.resolutionWidth, sourceImage.width) : sourceImage.width;
  const height = options.resizeImages ? sanitizePositiveInt(options.resolutionHeight, sourceImage.height) : sourceImage.height;
  const qualityPercent = clampQualityPercent(options.quality);
  const quality = qualityPercent / 100;
  const outputMimeType = options.convertToJpeg ? "image/jpeg" : file.type && file.type.startsWith("image/") ? file.type : "image/png";

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not create canvas context for image conversion");
  }

  // Fill with black so JPEG has deterministic bars/background.
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  if (options.resizeImages) {
    drawFittedImage(ctx, sourceImage, width, height, options.fit);
  } else {
    ctx.drawImage(sourceImage, 0, 0, width, height);
  }

  const dataUrl = outputMimeType === "image/jpeg" ? canvas.toDataURL(outputMimeType, quality) : canvas.toDataURL(outputMimeType);
  const outputName = options.convertToJpeg
    ? `${fileNameWithoutExtension(file.name)}.jpg`
    : `${fileNameWithoutExtension(file.name)}${extensionForMimeType(outputMimeType) || extensionForMimeType(file.type)}`;

  return {
    dataUrl,
    width,
    height,
    size: dataUrlSizeInBytes(dataUrl),
    mimeType: outputMimeType,
    name: outputName,
  };
}

/**
 * Dispatch event to notify components that image storage has changed
 */
function dispatchImagesChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pp-images-changed"));
  }
}

/**
 * Import an image file into storage
 */
export async function importImage(file: File, options?: ImageImportOptions): Promise<StoredImage> {
  try {
    const convertToJpeg = options?.convertToJpeg === true;
    const resizeImages = options?.resizeImages === true;
    let dataUrl: string;
    let dimensions: { width: number; height: number };
    let size: number;
    let mimeType: string;
    let name: string;

    if (convertToJpeg || resizeImages) {
      const converted = await processImageWithCanvas(file, {
        convertToJpeg,
        resizeImages,
        resolutionWidth: sanitizePositiveInt(options?.resolutionWidth, 1920),
        resolutionHeight: sanitizePositiveInt(options?.resolutionHeight, 1080),
        fit: options?.fit || "touchInner",
        quality: clampQualityPercent(options?.quality),
      });
      dataUrl = converted.dataUrl;
      dimensions = { width: converted.width, height: converted.height };
      size = converted.size;
      mimeType = converted.mimeType;
      name = converted.name;
    } else {
      dataUrl = await fileToDataUrl(file);
      dimensions = await getImageDimensions(dataUrl);
      size = file.size;
      mimeType = file.type;
      name = file.name;
    }

    const image: StoredImage = {
      id: generateImageId(),
      name,
      dataUrl,
      width: dimensions.width,
      height: dimensions.height,
      size,
      mimeType,
      dateAdded: Date.now(),
    };

    await imageStorage.setItem(image.id, image);
    console.info("ImageStorage", `Imported image: ${image.name} (${image.id})`);

    dispatchImagesChanged();

    return image;
  } catch (error) {
    console.error("ImageStorage", `Failed to import image: ${file.name}`, error);
    throw error;
  }
}

/**
 * Import multiple image files into storage
 */
export async function importImages(files: FileList | File[], options?: ImageImportOptions): Promise<StoredImage[]> {
  const images: StoredImage[] = [];
  const fileArray = Array.from(files);
  const imageFiles = fileArray.filter((file) => file.type.startsWith("image/"));
  const total = imageFiles.length;
  let processed = 0;
  let imported = 0;
  let failed = 0;

  options?.onProgress?.({ processed, total, imported, failed });

  for (const file of imageFiles) {
    try {
      const image = await importImage(file, options);
      images.push(image);
      imported++;
    } catch (error) {
      failed++;
      console.warn("ImageStorage", `Skipping file: ${file.name}`, error);
    }

    processed++;
    options?.onProgress?.({ processed, total, imported, failed, currentFileName: file.name });
  }

  return images;
}

/**
 * Get all stored images
 */
export async function getAllImages(): Promise<StoredImage[]> {
  try {
    const images: StoredImage[] = [];
    await imageStorage.iterate<StoredImage, void>((value) => {
      images.push(value);
    });
    // Sort by date added (newest first)
    images.sort((a, b) => b.dateAdded - a.dateAdded);
    return images;
  } catch (error) {
    console.error("ImageStorage", "Failed to get all images", error);
    return [];
  }
}

/**
 * Get a single image by ID
 */
export async function getImage(id: string): Promise<StoredImage | null> {
  try {
    return await imageStorage.getItem<StoredImage>(id);
  } catch (error) {
    console.error("ImageStorage", `Failed to get image: ${id}`, error);
    return null;
  }
}

/**
 * Delete an image by ID
 */
export async function deleteImage(id: string): Promise<void> {
  try {
    await imageStorage.removeItem(id);
    console.info("ImageStorage", `Deleted image: ${id}`);
    dispatchImagesChanged();
  } catch (error) {
    console.error("ImageStorage", `Failed to delete image: ${id}`, error);
    throw error;
  }
}

/**
 * Delete multiple images by IDs
 */
export async function deleteImages(ids: string[]): Promise<void> {
  for (const id of ids) {
    await deleteImage(id);
  }
}

/**
 * Clear all stored images
 */
export async function clearAllImages(): Promise<void> {
  try {
    await imageStorage.clear();
    console.info("ImageStorage", "Cleared all images");
    dispatchImagesChanged();
  } catch (error) {
    console.error("ImageStorage", "Failed to clear all images", error);
    throw error;
  }
}

/**
 * Get the total storage used by images (in bytes)
 */
export async function getStorageUsage(): Promise<number> {
  try {
    let totalSize = 0;
    await imageStorage.iterate<StoredImage, void>((value) => {
      totalSize += value.size;
    });
    return totalSize;
  } catch (error) {
    console.error("ImageStorage", "Failed to calculate storage usage", error);
    return 0;
  }
}

/**
 * Get count of stored images
 */
export async function getImageCount(): Promise<number> {
  try {
    return await imageStorage.length();
  } catch (error) {
    console.error("ImageStorage", "Failed to get image count", error);
    return 0;
  }
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export const imageStorageService = {
  importImage,
  importImages,
  getAllImages,
  getImage,
  deleteImage,
  deleteImages,
  clearAllImages,
  getStorageUsage,
  getImageCount,
  formatBytes,
};

export default imageStorageService;
