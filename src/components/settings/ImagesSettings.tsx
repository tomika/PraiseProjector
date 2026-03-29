import React, { useState, useEffect, useCallback } from "react";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import { useMessageBox } from "../../contexts/MessageBoxContext";
import { imageStorageService, StoredImage, formatBytes, ImageImportOptions, ImageImportProgress } from "../../services/ImageStorage";
import "./ImagesSettings.css";

interface ImagesSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

type ResolutionPreset = "640x480" | "854x480" | "1280x720" | "1920x1080" | "3840x2160" | "custom";

const RESOLUTION_PRESETS: Array<{ value: ResolutionPreset; label: string; width?: number; height?: number }> = [
  { value: "640x480", label: "480p (4:3) - 640x480", width: 640, height: 480 },
  { value: "854x480", label: "480p (16:9) - 854x480", width: 854, height: 480 },
  { value: "1280x720", label: "720p HD - 1280x720", width: 1280, height: 720 },
  { value: "1920x1080", label: "1080p Full HD - 1920x1080", width: 1920, height: 1080 },
  { value: "3840x2160", label: "4K UHD - 3840x2160", width: 3840, height: 2160 },
  { value: "custom", label: "Custom" },
];

const ImagesSettings: React.FC<ImagesSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const { showConfirm } = useMessageBox();
  const [images, setImages] = useState<StoredImage[]>([]);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [storageUsage, setStorageUsage] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const useImportCompression = settings.importImageUseCompression ?? false;
  const useImportResize = settings.importImageUseResize ?? false;
  const importResolutionWidth = settings.importImageResolutionWidth ?? 1920;
  const importResolutionHeight = settings.importImageResolutionHeight ?? 1080;
  const importResolutionPreset = (settings.importImageResolutionPreset as ResolutionPreset) ?? "1920x1080";
  const importFit = settings.importImageFit ?? "touchInner";
  const importQuality = settings.importImageJpegQuality ?? 85;
  const [showQualityPreview, setShowQualityPreview] = useState(false);
  const [importProgress, setImportProgress] = useState<ImageImportProgress | null>(null);
  const beforePreviewCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const afterPreviewCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const isElectron = typeof window !== "undefined" && !!window.electronAPI;
  const backgroundImageFitOptions: Array<{ value: Settings["backgroundImageFit"]; label: string }> = [
    { value: "touchInner", label: t("BackgroundImageFitTouchInner") || "Touch Inner" },
    { value: "touchOuter", label: t("BackgroundImageFitTouchOuter") || "Touch Outer" },
    { value: "stretch", label: t("BackgroundImageFitStretch") || "Stretch" },
    { value: "touchInnerMargins", label: t("BackgroundImageFitTouchInnerMargins") || "Touch Inner (Margins)" },
    { value: "touchOuterMargins", label: t("BackgroundImageFitTouchOuterMargins") || "Touch Outer (Margins)" },
    { value: "stretchMargins", label: t("BackgroundImageFitStretchMargins") || "Stretch (Margins)" },
  ];

  const getImportOptions = (): ImageImportOptions | undefined => {
    if (!useImportCompression && !useImportResize) {
      return undefined;
    }

    return {
      convertToJpeg: useImportCompression,
      resizeImages: useImportResize,
      resolutionWidth: Math.max(1, Math.round(importResolutionWidth || 1)),
      resolutionHeight: Math.max(1, Math.round(importResolutionHeight || 1)),
      fit: importFit,
      quality: Math.max(1, Math.min(100, Math.round(importQuality || 1))),
    };
  };

  const loadImageFromDataUrl = (dataUrl: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  };

  const renderCompressionPreview = React.useCallback(async () => {
    const beforeCanvas = beforePreviewCanvasRef.current;
    const afterCanvas = afterPreviewCanvasRef.current;
    if (!beforeCanvas || !afterCanvas) {
      return;
    }

    const source = document.createElement("canvas");
    source.width = 640;
    source.height = 360;
    const sourceCtx = source.getContext("2d");
    if (!sourceCtx) {
      return;
    }

    sourceCtx.fillStyle = "#f5f5f5";
    sourceCtx.fillRect(0, 0, source.width, source.height);
    sourceCtx.strokeStyle = "rgba(0,0,0,0.12)";
    for (let y = 0; y < source.height; y += 8) {
      sourceCtx.beginPath();
      sourceCtx.moveTo(0, y);
      sourceCtx.lineTo(source.width, y);
      sourceCtx.stroke();
    }
    sourceCtx.fillStyle = "#111";
    sourceCtx.font = "bold 34px Times New Roman";
    sourceCtx.fillText("Hallelujah 123", 40, 110);
    sourceCtx.font = "16px Arial";
    sourceCtx.fillText("Font edge artifact preview", 42, 138);
    sourceCtx.font = "14px Arial";
    sourceCtx.fillText("The quick brown fox jumps over the lazy dog", 42, 168);
    sourceCtx.strokeStyle = "#222";
    sourceCtx.lineWidth = 1;
    sourceCtx.beginPath();
    sourceCtx.moveTo(42, 190);
    sourceCtx.lineTo(280, 256);
    sourceCtx.moveTo(44, 191);
    sourceCtx.lineTo(282, 257);
    sourceCtx.stroke();

    const previewCrop = { x: 34, y: 84, width: 164, height: 96 };

    const drawZoomedCrop = (target: HTMLCanvasElement, src: CanvasImageSource) => {
      const ctx = target.getContext("2d");
      if (!ctx) {
        return;
      }
      ctx.clearRect(0, 0, target.width, target.height);
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, target.width, target.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, previewCrop.x, previewCrop.y, previewCrop.width, previewCrop.height, 0, 0, target.width, target.height);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, target.width - 1, target.height - 1);
    };

    drawZoomedCrop(beforeCanvas, source);

    try {
      const compressedDataUrl = source.toDataURL("image/jpeg", Math.max(0.01, Math.min(1, importQuality / 100)));
      const compressedImage = await loadImageFromDataUrl(compressedDataUrl);
      drawZoomedCrop(afterCanvas, compressedImage);
    } catch {
      drawZoomedCrop(afterCanvas, source);
    }
  }, [importQuality]);

  useEffect(() => {
    renderCompressionPreview();
  }, [renderCompressionPreview]);

  const importFileCollection = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;

    setIsImporting(true);
    setImportProgress({ processed: 0, total: 0, imported: 0, failed: 0 });
    try {
      const importOptions = getImportOptions();
      await imageStorageService.importImages(files, {
        ...importOptions,
        onProgress: (progress) => {
          setImportProgress(progress);
        },
      });
      await loadImages();
    } catch (error) {
      console.error("Failed to import images:", error);
    } finally {
      setImportProgress(null);
      setIsImporting(false);
    }
  };

  const handlePresetChange = (preset: ResolutionPreset) => {
    updateSetting("importImageResolutionPreset", preset);
    const selected = RESOLUTION_PRESETS.find((item) => item.value === preset);
    if (selected?.width && selected?.height) {
      updateSetting("importImageResolutionWidth", selected.width);
      updateSetting("importImageResolutionHeight", selected.height);
    }
  };

  const handleWidthChange = (nextValue: number) => {
    updateSetting("importImageResolutionPreset", "custom");
    updateSetting("importImageResolutionWidth", nextValue);
  };

  const handleHeightChange = (nextValue: number) => {
    updateSetting("importImageResolutionPreset", "custom");
    updateSetting("importImageResolutionHeight", nextValue);
  };

  // Load images on mount
  const loadImages = useCallback(async () => {
    setIsLoading(true);
    try {
      const storedImages = await imageStorageService.getAllImages();
      setImages(storedImages);
      const usage = await imageStorageService.getStorageUsage();
      setStorageUsage(usage);
    } catch (error) {
      console.error("Failed to load images:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadImages();
  }, [loadImages]);

  // Handle file import
  const handleImportClick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = async (event) => {
      const files = (event.target as HTMLInputElement).files;
      await importFileCollection(files || []);
    };
    input.click();
  };

  // Handle folder import (if supported)
  const handleImportFolderClick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    // webkitdirectory attribute for folder selection
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.onchange = async (event) => {
      const files = (event.target as HTMLInputElement).files;
      await importFileCollection(files || []);
    };
    input.click();
  };

  // Handle image selection toggle
  const toggleImageSelection = (id: string) => {
    setSelectedImages((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  // Handle select all
  const handleSelectAll = () => {
    if (selectedImages.size === images.length) {
      setSelectedImages(new Set());
    } else {
      setSelectedImages(new Set(images.map((img) => img.id)));
    }
  };

  // Handle delete selected
  const handleDeleteSelected = () => {
    if (selectedImages.size === 0) return;

    const message =
      t("ConfirmDeleteImages")?.replace("{count}", selectedImages.size.toString()) ||
      `Are you sure you want to delete ${selectedImages.size} image(s)?`;

    showConfirm(
      t("Confirm") || "Confirm",
      message,
      async () => {
        try {
          await imageStorageService.deleteImages(Array.from(selectedImages));
          setSelectedImages(new Set());
          await loadImages();
        } catch (error) {
          console.error("Failed to delete images:", error);
        }
      },
      undefined,
      { confirmText: t("DeleteImagesConfirm"), confirmDanger: true }
    );
  };

  // Handle clear all
  const handleClearAll = () => {
    if (images.length === 0) return;

    const message = t("ConfirmClearAllImages");

    showConfirm(
      t("Confirm") || "Confirm",
      message,
      async () => {
        try {
          await imageStorageService.clearAllImages();
          setSelectedImages(new Set());
          await loadImages();
        } catch (error) {
          console.error("Failed to clear images:", error);
        }
      },
      undefined,
      { confirmText: t("ClearAllImagesConfirm"), confirmDanger: true }
    );
  };

  return (
    <div className="images-settings">
      <div className="picture-settings-section">
        <div className="form-group mb-3">
          <label htmlFor="backgroundImageFit">{t("BackgroundImageFit") || "Background Image Fit"}</label>
          <select
            className="form-select"
            id="backgroundImageFit"
            value={settings.backgroundImageFit || "touchInner"}
            onChange={(e) => updateSetting("backgroundImageFit", e.target.value as Settings["backgroundImageFit"])}
          >
            {backgroundImageFitOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <small className="form-text text-muted">
            {t("BackgroundImageFitHelp") ||
              "Touch Inner keeps the whole image visible, Touch Outer fills the screen by cropping, Stretch fills the screen by distorting the image. Margin variants apply the same fit inside the projection margins."}
          </small>
        </div>

        {/* Picture folder setting - only visible in Electron mode */}
        {isElectron && (
          <div className="form-group mb-3">
            <label htmlFor="pictureFolder">{t("SettingsPictureFolder")}</label>
            <div className="input-group">
              <input
                type="text"
                className="form-control"
                id="pictureFolder"
                value={settings.pictureFolder}
                onChange={(e) => updateSetting("pictureFolder", e.target.value)}
                placeholder={t("SettingsPictureFolderPlaceholder") || "Enter path to images folder..."}
              />
              <div className="input-group-append">
                <button
                  className="btn btn-outline-secondary"
                  type="button"
                  onClick={() => {
                    // Use Electron's dialog if available
                    if (window.electronAPI?.selectFolder) {
                      window.electronAPI.selectFolder().then((path) => {
                        if (path) {
                          updateSetting("pictureFolder", path);
                        }
                      });
                    }
                  }}
                >
                  {t("SettingsBrowse")}
                </button>
              </div>
            </div>
            <small className="form-text text-muted">
              {t("SettingsPictureFolderDescription") || "Path to folder containing background images (Electron only)"}
            </small>
          </div>
        )}
      </div>

      <div className="picture-settings-divider" />

      {/* Internal Image Storage */}
      <div className="internal-images-section">
        <h6>{t("InternalImageStorage") || "Internal Image Storage"}</h6>
        <p className="text-muted small">
          {t("InternalImageStorageDescription") ||
            "Import images to store them in the application. These images are available in both web and desktop modes."}
        </p>

        {/* Warning about permanent changes */}
        <div className="alert alert-warning py-2 mb-2">
          <i className="fa fa-exclamation-triangle me-2"></i>
          <strong>{t("Warning") || "Warning"}:</strong>{" "}
          {t("ImageChangesPermanentWarning") ||
            "All changes in the image storage maintainer section (import/delete) are applied immediately and cannot be undone."}
        </div>

        {/* Storage info */}
        <div className="storage-info mb-2">
          <span className="badge bg-secondary">
            {images.length} {images.length === 1 ? t("Image") : t("Images")} • {formatBytes(storageUsage)}
          </span>
        </div>

        <div className="import-options-panel mb-2">
          <div className="form-check mb-1">
            <input
              className="form-check-input"
              type="checkbox"
              id="useImportCompression"
              checked={useImportCompression}
              onChange={(e) => updateSetting("importImageUseCompression", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="useImportCompression">
              {t("ImportConvertToJpeg") || "Compress imported images as JPEG"}
            </label>

            <small className="text-muted d-block mt-2">
              {t("ImportConvertHelp") || "Compression (JPEG quality) and resizing are independent. You can enable either one, both, or neither."}
            </small>
          </div>
          {useImportCompression && (
            <>
              <label className="form-label mb-1" htmlFor="importQualitySlider">
                {(t("ImportQuality") || "JPEG Quality") + ` (${importQuality}%)`}
              </label>
              <input
                id="importQualitySlider"
                type="range"
                min={1}
                max={100}
                step={1}
                className="form-range"
                value={importQuality}
                onChange={(e) => {
                  updateSetting("importImageJpegQuality", parseInt(e.target.value || "1", 10));
                  setShowQualityPreview(true);
                }}
                onPointerUp={() => setShowQualityPreview(false)}
                onMouseUp={() => setShowQualityPreview(false)}
                onTouchEnd={() => setShowQualityPreview(false)}
                onBlur={() => setShowQualityPreview(false)}
              />

              {showQualityPreview && (
                <>
                  <div className="import-quality-preview mb-2">
                    <div className="import-quality-preview-item">
                      <div className="import-quality-preview-label">{t("ImportPreviewBefore") || "Before"}</div>
                      <canvas
                        ref={beforePreviewCanvasRef}
                        className="import-quality-preview-canvas"
                        width={328}
                        height={192}
                        aria-label={t("ImportPreviewBefore") || "Before"}
                      />
                    </div>
                    <div className="import-quality-preview-item">
                      <div className="import-quality-preview-label">{t("ImportPreviewAfter") || "After"}</div>
                      <canvas
                        ref={afterPreviewCanvasRef}
                        className="import-quality-preview-canvas"
                        width={328}
                        height={192}
                        aria-label={t("ImportPreviewAfter") || "After"}
                      />
                    </div>
                  </div>

                  <small className="text-muted d-block mb-2">
                    {t("ImportQualityPreviewHelp") ||
                      "Preview shows a zoomed text-edge area to make JPEG artifacts easy to spot while adjusting quality."}
                  </small>
                </>
              )}

              <div className="form-check mb-2">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="useImportResize"
                  checked={useImportResize}
                  onChange={(e) => updateSetting("importImageUseResize", e.target.checked)}
                />
                <label className="form-check-label" htmlFor="useImportResize">
                  {t("ImportResizeImages") || "Resize images"}
                </label>
                <div className="col-12">
                  <small className="text-muted">{t("ImportResizeHelp") || "Resize controls apply only when Resize images is enabled."}</small>
                </div>
              </div>

              {useImportResize && (
                <div className="row g-2 align-items-end">
                  <div className="col-sm-3">
                    <label className="form-label mb-1" htmlFor="importResolutionPreset">
                      {t("ImportResolutionPreset") || "Resolution Preset"}
                    </label>
                    <select
                      id="importResolutionPreset"
                      className="form-select form-select-sm"
                      value={importResolutionPreset}
                      onChange={(e) => handlePresetChange(e.target.value as ResolutionPreset)}
                    >
                      {RESOLUTION_PRESETS.map((preset) => (
                        <option key={preset.value} value={preset.value}>
                          {preset.value === "custom" ? t("ImportResolutionCustom") || "Custom" : preset.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-sm-3">
                    <label className="form-label mb-1" htmlFor="importResolutionWidth">
                      {t("ImportResolutionWidth") || "Width"}
                    </label>
                    <input
                      id="importResolutionWidth"
                      type="number"
                      min={1}
                      className="form-control form-control-sm"
                      value={importResolutionWidth}
                      onChange={(e) => handleWidthChange(parseInt(e.target.value || "1", 10))}
                    />
                  </div>
                  <div className="col-sm-2">
                    <label className="form-label mb-1" htmlFor="importResolutionHeight">
                      {t("ImportResolutionHeight") || "Height"}
                    </label>
                    <input
                      id="importResolutionHeight"
                      type="number"
                      min={1}
                      className="form-control form-control-sm"
                      value={importResolutionHeight}
                      onChange={(e) => handleHeightChange(parseInt(e.target.value || "1", 10))}
                    />
                  </div>
                  <div className="col-sm-2">
                    <label className="form-label mb-1" htmlFor="importFit">
                      {t("ImportFit") || "Fit"}
                    </label>
                    <select
                      id="importFit"
                      className="form-select form-select-sm"
                      value={importFit}
                      onChange={(e) => updateSetting("importImageFit", e.target.value as "touchInner" | "touchOuter" | "stretch")}
                    >
                      <option value="touchInner">{t("BackgroundImageFitTouchInner") || "Touch Inner"}</option>
                      <option value="touchOuter">{t("BackgroundImageFitTouchOuter") || "Touch Outer"}</option>
                      <option value="stretch">{t("BackgroundImageFitStretch") || "Stretch"}</option>
                    </select>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Toolbar */}
        <div className="images-toolbar mb-2">
          <button className="btn btn-sm btn-primary me-2" onClick={handleImportClick} disabled={isImporting}>
            <i className="fa fa-plus me-1"></i>
            {t("ImportImages") || "Import Images"}
          </button>
          <button
            className="btn btn-sm btn-outline-primary me-2"
            onClick={handleImportFolderClick}
            disabled={isImporting}
            title={t("ImportFolderTooltip") || "Import all images from a folder"}
          >
            <i className="fa fa-folder-open me-1"></i>
            {t("ImportFolder") || "Import Folder"}
          </button>
          {images.length > 0 && (
            <>
              <button className="btn btn-sm btn-outline-secondary me-2" onClick={handleSelectAll}>
                {selectedImages.size === images.length ? t("DeselectAll") : t("SelectAll")}
              </button>
              {selectedImages.size > 0 && (
                <button className="btn btn-sm btn-danger me-2" onClick={handleDeleteSelected}>
                  <i className="fa fa-trash me-1"></i>
                  {t("DeleteSelected") || "Delete Selected"} ({selectedImages.size})
                </button>
              )}
              <button className="btn btn-sm btn-outline-danger" onClick={handleClearAll}>
                {t("ClearAll") || "Clear All"}
              </button>
            </>
          )}
        </div>

        {/* Loading indicator */}
        {isLoading && (
          <div className="text-center py-3">
            <div className="spinner-border spinner-border-sm" role="status">
              <span className="visually-hidden">Loading...</span>
            </div>
          </div>
        )}

        {/* Import progress */}
        {isImporting && (
          <div className="alert alert-info py-2">
            <div className="spinner-border spinner-border-sm me-2" role="status"></div>
            {t("ImportingImages") || "Importing images..."}
            {importProgress && importProgress.total > 0 && (
              <>
                <div className="small mt-2">
                  {(t("ImportProgress") || "Progress") +
                    `: ${importProgress.processed}/${importProgress.total} • ${importProgress.imported} OK • ${importProgress.failed} failed`}
                </div>
                {importProgress.currentFileName && <div className="small text-muted">{importProgress.currentFileName}</div>}
                <progress
                  className="image-import-progress-bar mt-2"
                  value={importProgress.processed}
                  max={importProgress.total}
                  aria-label={t("ImportProgress") || "Progress"}
                >
                  {importProgress.processed}/{importProgress.total}
                </progress>
              </>
            )}
          </div>
        )}

        {/* Image grid */}
        {!isLoading && images.length === 0 && (
          <div className="empty-state text-center py-4 text-muted">
            <i className="fa fa-image fa-3x mb-2"></i>
            <p>{t("NoImagesImported") || "No images imported yet"}</p>
            <p className="small">{t("ClickImportToAdd") || "Click 'Import Images' to add background images"}</p>
          </div>
        )}

        {!isLoading && images.length > 0 && (
          <div className="images-grid">
            {images.map((image) => (
              <div
                key={image.id}
                className={`image-item ${selectedImages.has(image.id) ? "selected" : ""}`}
                onClick={() => toggleImageSelection(image.id)}
              >
                <div className="image-thumbnail-wrapper">
                  <img src={image.dataUrl} alt={image.name} />
                  {selectedImages.has(image.id) && (
                    <div className="selection-indicator">
                      <i className="fa fa-check"></i>
                    </div>
                  )}
                </div>
                <div className="image-info">
                  <span className="image-name" title={image.name}>
                    {image.name}
                  </span>
                  <span className="image-size">{formatBytes(image.size)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ImagesSettings;
