import React, { useState, useEffect, useCallback } from "react";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import { useMessageBox } from "../../contexts/MessageBoxContext";
import { imageStorageService, StoredImage, formatBytes } from "../../services/ImageStorage";
import "./ImagesSettings.css";

interface ImagesSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const ImagesSettings: React.FC<ImagesSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const { showConfirm } = useMessageBox();
  const [images, setImages] = useState<StoredImage[]>([]);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [storageUsage, setStorageUsage] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const isElectron = typeof window !== "undefined" && !!window.electronAPI;
  const backgroundImageFitOptions: Array<{ value: Settings["backgroundImageFit"]; label: string }> = [
    { value: "touchInner", label: t("BackgroundImageFitTouchInner") || "Touch Inner" },
    { value: "touchOuter", label: t("BackgroundImageFitTouchOuter") || "Touch Outer" },
    { value: "stretch", label: t("BackgroundImageFitStretch") || "Stretch" },
  ];

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
      if (!files || files.length === 0) return;

      setIsImporting(true);
      try {
        await imageStorageService.importImages(files);
        await loadImages();
      } catch (error) {
        console.error("Failed to import images:", error);
      } finally {
        setIsImporting(false);
      }
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
      if (!files || files.length === 0) return;

      setIsImporting(true);
      try {
        await imageStorageService.importImages(files);
        await loadImages();
      } catch (error) {
        console.error("Failed to import images:", error);
      } finally {
        setIsImporting(false);
      }
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
            "Touch Inner keeps the whole image visible, Touch Outer fills the screen by cropping, Stretch fills the screen by distorting the image."}
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

      {/* Divider */}
      {isElectron && <hr className="my-3" />}

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
          {t("ImageChangesPermanentWarning") || "All changes on this page (import/delete) are applied immediately and cannot be undone."}
        </div>

        {/* Storage info */}
        <div className="storage-info mb-2">
          <span className="badge bg-secondary">
            {images.length} {images.length === 1 ? t("Image") : t("Images")} • {formatBytes(storageUsage)}
          </span>
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
