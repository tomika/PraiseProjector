import React, { useState, useEffect, useCallback, useRef } from "react";
import { imageStorageService, StoredImage } from "../../services/ImageStorage";
import { useSettings } from "../../hooks/useSettings";
import { useLocalization } from "../../localization/LocalizationContext";
import { useTooltips } from "../../localization/TooltipContext";
import "./ImageSelector.css";

interface ExternalImage {
  path: string;
  name: string;
  dataUrl?: string;
}

interface ImageSelectorProps {
  selectedImageId: string | null;
  onSelectImage: (imageId: string | null, dataUrl: string | null) => void;
  onOpenImageSettings?: () => void;
}

// Debounce delay before loading images (ms) - prevents loading images that are quickly scrolled past
const LAZY_LOAD_DEBOUNCE_MS = 150;

// Component for lazy-loading individual external images with debounce
const LazyExternalImage: React.FC<{
  image: ExternalImage;
  imageId: string;
  isSelected: boolean;
  onSelect: () => void;
  title: string;
  externalBadgeTitle?: string;
}> = ({ image, imageId: _imageId, isSelected, onSelect, title, externalBadgeTitle }) => {
  const [dataUrl, setDataUrl] = useState<string | undefined>(image.dataUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  const elementRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Use IntersectionObserver to detect when element is visible
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            // Start debounce timer when element becomes visible
            debounceTimerRef.current = setTimeout(() => {
              setShouldLoad(true);
              observer.unobserve(element);
            }, LAZY_LOAD_DEBOUNCE_MS);
          } else {
            // Cancel timer if element scrolls out of view before timer fires
            if (debounceTimerRef.current) {
              clearTimeout(debounceTimerRef.current);
              debounceTimerRef.current = null;
            }
          }
        });
      },
      { rootMargin: "50px" } // Start observing 50px before visible
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Load image data when shouldLoad is true and not already loaded
  useEffect(() => {
    if (!shouldLoad || dataUrl || isLoading) return;

    const loadImage = async () => {
      if (window.electronAPI?.readImageAsDataUrl) {
        setIsLoading(true);
        try {
          const url = await window.electronAPI.readImageAsDataUrl(image.path);
          if (url) {
            setDataUrl(url);
          }
        } catch (error) {
          console.error("Failed to load image:", error);
        } finally {
          setIsLoading(false);
        }
      }
    };

    loadImage();
  }, [shouldLoad, dataUrl, isLoading, image.path]);

  return (
    <div ref={elementRef} className={`image-selector-item external ${isSelected ? "selected" : ""}`} onClick={onSelect} title={title}>
      {dataUrl ? (
        <img src={dataUrl} alt={image.name} />
      ) : (
        <div className="external-placeholder">
          {isLoading ? (
            <div className="spinner-border spinner-border-sm" role="status">
              <span className="visually-hidden">Loading...</span>
            </div>
          ) : (
            <i className="fa fa-image"></i>
          )}
        </div>
      )}
      {isSelected && (
        <div className="selection-check">
          <i className="fa fa-check"></i>
        </div>
      )}
      <div className="external-badge" title={externalBadgeTitle}>
        <i className="fa fa-folder"></i>
      </div>
    </div>
  );
};

const ImageSelector: React.FC<ImageSelectorProps> = ({ selectedImageId, onSelectImage, onOpenImageSettings }) => {
  const { settings } = useSettings();
  const { t } = useLocalization();
  const [internalImages, setInternalImages] = useState<StoredImage[]>([]);
  const [externalImages, setExternalImages] = useState<ExternalImage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const isElectron = typeof window !== "undefined" && !!window.electronAPI;
  const { tt } = useTooltips();

  // Load internal images from IndexedDB
  const loadInternalImages = useCallback(async () => {
    try {
      const images = await imageStorageService.getAllImages();
      setInternalImages(images);
    } catch (error) {
      console.error("Failed to load internal images:", error);
    }
  }, []);

  // Load external images list from picture folder (Electron only)
  // Note: We only load the file list here, actual image data is loaded lazily
  const loadExternalImages = useCallback(async () => {
    if (!isElectron || !settings?.pictureFolder || !window.electronAPI?.listImagesInFolder) {
      setExternalImages([]);
      return;
    }

    try {
      const images = await window.electronAPI.listImagesInFolder(settings.pictureFolder);
      if (!images || images.length === 0) {
        setExternalImages([]);
        return;
      }

      // Store images without loading data URLs - they will be loaded lazily
      setExternalImages(images);
    } catch (error) {
      console.error("Failed to load external images:", error);
      setExternalImages([]);
    }
  }, [isElectron, settings?.pictureFolder]);

  // Load all images on mount and when settings change
  useEffect(() => {
    const loadAll = async () => {
      setIsLoading(true);
      await Promise.all([loadInternalImages(), loadExternalImages()]);
      setIsLoading(false);
    };
    loadAll();
  }, [loadInternalImages, loadExternalImages]);

  // Listen for settings changes to reload external images
  useEffect(() => {
    const handleSettingsChange = () => {
      loadExternalImages();
    };
    window.addEventListener("pp-settings-changed", handleSettingsChange);
    return () => {
      window.removeEventListener("pp-settings-changed", handleSettingsChange);
    };
  }, [loadExternalImages]);

  // Listen for image storage changes to reload internal images
  useEffect(() => {
    const handleStorageChange = () => {
      loadInternalImages();
    };
    window.addEventListener("pp-images-changed", handleStorageChange);
    return () => {
      window.removeEventListener("pp-images-changed", handleStorageChange);
    };
  }, [loadInternalImages]);

  // Handle image selection
  const handleSelectInternal = (image: StoredImage) => {
    if (selectedImageId === image.id) {
      // Deselect if already selected
      onSelectImage(null, null);
    } else {
      onSelectImage(image.id, image.dataUrl);
    }
  };

  const handleSelectExternal = useCallback(
    async (image: ExternalImage) => {
      const imageId = `ext:${image.path}`;
      if (selectedImageId === imageId) {
        // Deselect if already selected
        onSelectImage(null, null);
      } else {
        // For external images, we need to load the data URL if not already loaded
        if (window.electronAPI?.readImageAsDataUrl) {
          const dataUrl = await window.electronAPI.readImageAsDataUrl(image.path);
          if (dataUrl) {
            onSelectImage(imageId, dataUrl);
          }
        }
      }
    },
    [selectedImageId, onSelectImage]
  );

  const hasImages = internalImages.length > 0 || externalImages.length > 0;
  const [isExpanded, setIsExpanded] = useState(false);

  // Render the image grid content (shared between normal and expanded view)
  const renderImageGrid = (expandedMode: boolean = false) => (
    <div className={`image-selector-grid ${expandedMode ? "expanded" : ""}`}>
      {/* Internal images */}
      {internalImages.map((image) => (
        <div
          key={image.id}
          className={`image-selector-item ${selectedImageId === image.id ? "selected" : ""}`}
          onClick={() => handleSelectInternal(image)}
          title={image.name}
        >
          <img src={image.dataUrl} alt={image.name} />
          {selectedImageId === image.id && (
            <div className="selection-check">
              <i className="fa fa-check"></i>
            </div>
          )}
        </div>
      ))}

      {/* External images (Electron only) - using lazy loading */}
      {externalImages.map((image) => {
        const imageId = `ext:${image.path}`;
        return (
          <LazyExternalImage
            key={imageId}
            image={image}
            imageId={imageId}
            isSelected={selectedImageId === imageId}
            onSelect={() => handleSelectExternal(image)}
            title={`${image.name} (${t("External")})`}
            externalBadgeTitle={tt("imagelist_external_image")}
          />
        );
      })}
    </div>
  );

  return (
    <>
      <div className="image-selector">
        {hasImages && (
          <div className="image-selector-btn-row">
            {onOpenImageSettings && (
              <button
                className="image-selector-settings-btn"
                onClick={onOpenImageSettings}
                title={tt("toolbar_settings")}
                aria-label={tt("toolbar_settings")}
              >
                <i className="fa fa-gear"></i>
              </button>
            )}
            <button className="image-selector-expand-btn" onClick={() => setIsExpanded(true)} title={tt("imagelist_expand")}>
              <i className="fa fa-expand"></i>
            </button>
          </div>
        )}

        {isLoading && (
          <div className="text-center py-2">
            <div className="spinner-border spinner-border-sm" role="status">
              <span className="visually-hidden">Loading...</span>
            </div>
          </div>
        )}

        {!isLoading && !hasImages && (
          <div className="empty-images-message text-muted text-center py-3">
            <button
              className="empty-images-action empty-images-action-icon"
              onClick={onOpenImageSettings}
              disabled={!onOpenImageSettings}
              title={t("ImportImagesInSettings") || "Import images in Settings → Images"}
              aria-label={t("ImportImagesInSettings") || "Import images in Settings → Images"}
            >
              <i className="fa fa-image fa-2x d-block opacity-50"></i>
            </button>
            <p className="mb-1">{t("NoImagesAvailable") || "No images available"}</p>
            <button
              className="empty-images-action empty-images-action-text small"
              onClick={onOpenImageSettings}
              disabled={!onOpenImageSettings}
              title={t("ImportImagesInSettings") || "Import images in Settings → Images"}
            >
              {t("ImportImagesInSettings") || "Import images in Settings → Images"}
            </button>
          </div>
        )}

        {!isLoading && hasImages && renderImageGrid(false)}
      </div>

      {/* Expanded popup modal */}
      {isExpanded && (
        <div className="image-selector-popup-backdrop" onClick={() => setIsExpanded(false)}>
          <div className="image-selector-popup" onClick={(e) => e.stopPropagation()}>
            <div className="image-selector-popup-header">
              <h6 className="m-0">{t("SelectBackgroundImage") || "Select Background Image"}</h6>
              <div className="d-flex align-items-center gap-2">
                {onOpenImageSettings && (
                  <button
                    className="image-selector-settings-btn"
                    onClick={() => {
                      setIsExpanded(false);
                      onOpenImageSettings();
                    }}
                    title={tt("toolbar_settings")}
                    aria-label={tt("toolbar_settings")}
                  >
                    <i className="fa fa-gear"></i>
                  </button>
                )}
                <button className="btn-close" onClick={() => setIsExpanded(false)} aria-label="Close"></button>
              </div>
            </div>
            <div className="image-selector-popup-body">{renderImageGrid(true)}</div>
          </div>
        </div>
      )}
    </>
  );
};

export default ImageSelector;
