import React from "react";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import { generateQRCodeSVG } from "../../hooks/useSessionUrl";
import "./ProjectingSettings.css";
import SafeSlider from "../SafeSlider";

const MAX_MARGIN_SUM = 95;

type MarginSide = "top" | "left" | "right" | "bottom";
type MarginHandle = "top" | "right" | "bottom" | "left" | "top-left" | "top-right" | "bottom-right" | "bottom-left";

const marginHandleToSides: Record<MarginHandle, MarginSide[]> = {
  top: ["top"],
  right: ["right"],
  bottom: ["bottom"],
  left: ["left"],
  "top-left": ["top", "left"],
  "top-right": ["top", "right"],
  "bottom-right": ["bottom", "right"],
  "bottom-left": ["bottom", "left"],
};

const clampMarginValue = (value: number, oppositeValue: number) => {
  const normalizedValue = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(MAX_MARGIN_SUM - oppositeValue, Math.round(normalizedValue)));
};

interface ProjectingSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const ProjectingSettings: React.FC<ProjectingSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const marginPreviewRef = React.useRef<HTMLDivElement | null>(null);
  const marginPreviewInnerRef = React.useRef<HTMLDivElement | null>(null);
  const [draggingMarginHandle, setDraggingMarginHandle] = React.useState<MarginHandle | null>(null);
  const [draggingBox, setDraggingBox] = React.useState<{
    startX: number;
    startY: number;
    startLeft: number;
    startRightMargin: number;
    startTop: number;
    startBottomMargin: number;
  } | null>(null);
  const [isQrDragging, setIsQrDragging] = React.useState(false);
  const [marginPreviewSize, setMarginPreviewSize] = React.useState({ width: 0, height: 0 });
  const qrDragRef = React.useRef({ startX: 0, startY: 0, startQrX: 0, startQrY: 0 });
  const marginPreviewQrRef = React.useRef<HTMLDivElement | null>(null);

  const updateDisplayMargin = React.useCallback(
    (side: MarginSide, nextValue: number) => {
      const currentRect = settings.displayBorderRect;

      switch (side) {
        case "top":
          updateSetting("displayBorderRect", {
            ...currentRect,
            top: clampMarginValue(nextValue, currentRect.height),
          });
          return;
        case "bottom":
          updateSetting("displayBorderRect", {
            ...currentRect,
            height: clampMarginValue(nextValue, currentRect.top),
          });
          return;
        case "left":
          updateSetting("displayBorderRect", {
            ...currentRect,
            left: clampMarginValue(nextValue, currentRect.width),
          });
          return;
        case "right":
          updateSetting("displayBorderRect", {
            ...currentRect,
            width: clampMarginValue(nextValue, currentRect.left),
          });
      }
    },
    [settings.displayBorderRect, updateSetting]
  );

  const clampQrPosition = React.useCallback(
    (x: number, y: number, sizePercent: number) => {
      const width = marginPreviewSize.width;
      const height = marginPreviewSize.height;

      if (width <= 0 || height <= 0) {
        return {
          x: Math.max(0, Math.min(100, x)),
          y: Math.max(0, Math.min(100, y)),
        };
      }

      const qrSizePx = height * (sizePercent / 100);
      const maxX = Math.max(0, 100 - (qrSizePx / width) * 100);
      const maxY = Math.max(0, 100 - (qrSizePx / height) * 100);

      return {
        x: Math.max(0, Math.min(maxX, x)),
        y: Math.max(0, Math.min(maxY, y)),
      };
    },
    [marginPreviewSize.height, marginPreviewSize.width]
  );

  const updateQrSize = React.useCallback(
    (nextSize: number) => {
      const normalizedSize = Math.max(1, Math.min(100, Math.round(nextSize)));
      const clamped = clampQrPosition(settings.qrCodeX, settings.qrCodeY, normalizedSize);

      updateSetting("qrCodeSizePercent", normalizedSize);
      if (Math.abs(clamped.x - settings.qrCodeX) > 0.01) {
        updateSetting("qrCodeX", clamped.x);
      }
      if (Math.abs(clamped.y - settings.qrCodeY) > 0.01) {
        updateSetting("qrCodeY", clamped.y);
      }
    },
    [clampQrPosition, settings.qrCodeX, settings.qrCodeY, updateSetting]
  );

  const updateQrAxis = (axis: "x" | "y", rawValue: number) => {
    const numericValue = Number.isFinite(rawValue) ? rawValue : 0;
    const currentSize = settings.qrCodeSizePercent ?? 15;
    const currentX = settings.qrCodeX ?? 85;
    const currentY = settings.qrCodeY ?? 82;
    const clamped = clampQrPosition(axis === "x" ? numericValue : currentX, axis === "y" ? numericValue : currentY, currentSize);

    if (axis === "x") {
      updateSetting("qrCodeX", Math.round(clamped.x));
      return;
    }
    updateSetting("qrCodeY", Math.round(clamped.y));
  };

  const handleMarginInputChange = (side: MarginSide) => (e: React.ChangeEvent<HTMLInputElement>) => {
    updateDisplayMargin(side, parseInt(e.target.value || "0", 10) || 0);
  };

  const startMarginDrag = (handle: MarginHandle) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingMarginHandle(handle);
  };

  const startBoxDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingBox({
      startX: e.clientX,
      startY: e.clientY,
      startLeft: settings.displayBorderRect.left,
      startRightMargin: settings.displayBorderRect.width,
      startTop: settings.displayBorderRect.top,
      startBottomMargin: settings.displayBorderRect.height,
    });
  };

  const startQrDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !settings.qrCodeInPreview) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    qrDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startQrX: settings.qrCodeX ?? 85,
      startQrY: settings.qrCodeY ?? 82,
    };
    setIsQrDragging(true);

    const handlePointerMove = (event: PointerEvent) => {
      const preview = marginPreviewRef.current;
      if (!preview || !preview.offsetWidth || !preview.offsetHeight) {
        return;
      }

      const dx = ((event.clientX - qrDragRef.current.startX) / preview.offsetWidth) * 100;
      const dy = ((event.clientY - qrDragRef.current.startY) / preview.offsetHeight) * 100;
      const clamped = clampQrPosition(qrDragRef.current.startQrX + dx, qrDragRef.current.startQrY + dy, settings.qrCodeSizePercent ?? 15);

      updateSetting("qrCodeX", clamped.x);
      updateSetting("qrCodeY", clamped.y);
    };

    const handlePointerUp = () => {
      setIsQrDragging(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const handleQrWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!settings.qrCodeInPreview) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -2 : 2;
    updateQrSize((settings.qrCodeSizePercent ?? 15) + delta);
  };

  React.useEffect(() => {
    if (!draggingMarginHandle) {
      return undefined;
    }

    const draggedSides = marginHandleToSides[draggingMarginHandle];

    const handlePointerMove = (event: PointerEvent) => {
      const previewBounds = marginPreviewRef.current?.getBoundingClientRect();
      if (!previewBounds || !previewBounds.width || !previewBounds.height) {
        return;
      }

      const pointerMargins = {
        left: ((event.clientX - previewBounds.left) / previewBounds.width) * 100,
        right: ((previewBounds.right - event.clientX) / previewBounds.width) * 100,
        top: ((event.clientY - previewBounds.top) / previewBounds.height) * 100,
        bottom: ((previewBounds.bottom - event.clientY) / previewBounds.height) * 100,
      };

      const currentRect = settings.displayBorderRect;
      const nextRect = { ...currentRect };

      if (draggedSides.includes("left")) {
        nextRect.left = clampMarginValue(pointerMargins.left, nextRect.width);
      }
      if (draggedSides.includes("right")) {
        nextRect.width = clampMarginValue(pointerMargins.right, nextRect.left);
      }
      if (draggedSides.includes("top")) {
        nextRect.top = clampMarginValue(pointerMargins.top, nextRect.height);
      }
      if (draggedSides.includes("bottom")) {
        nextRect.height = clampMarginValue(pointerMargins.bottom, nextRect.top);
      }

      updateSetting("displayBorderRect", nextRect);
    };

    const handlePointerUp = () => {
      setDraggingMarginHandle(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [draggingMarginHandle, settings.displayBorderRect, updateSetting]);

  React.useEffect(() => {
    if (!draggingBox) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const previewBounds = marginPreviewRef.current?.getBoundingClientRect();
      if (!previewBounds || !previewBounds.width || !previewBounds.height) {
        return;
      }

      const dx = ((event.clientX - draggingBox.startX) / previewBounds.width) * 100;
      const dy = ((event.clientY - draggingBox.startY) / previewBounds.height) * 100;

      // Clamp so neither margin goes below 0
      const clampedDx = Math.max(-draggingBox.startLeft, Math.min(draggingBox.startRightMargin, dx));
      const clampedDy = Math.max(-draggingBox.startTop, Math.min(draggingBox.startBottomMargin, dy));

      updateSetting("displayBorderRect", {
        left: Math.round(draggingBox.startLeft + clampedDx),
        width: Math.round(draggingBox.startRightMargin - clampedDx),
        top: Math.round(draggingBox.startTop + clampedDy),
        height: Math.round(draggingBox.startBottomMargin - clampedDy),
      });
    };

    const handlePointerUp = () => {
      setDraggingBox(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [draggingBox, updateSetting]);

  React.useEffect(() => {
    if (!marginPreviewInnerRef.current) {
      return;
    }

    marginPreviewInnerRef.current.style.left = `${settings.displayBorderRect.left}%`;
    marginPreviewInnerRef.current.style.top = `${settings.displayBorderRect.top}%`;
    marginPreviewInnerRef.current.style.right = `${settings.displayBorderRect.width}%`;
    marginPreviewInnerRef.current.style.bottom = `${settings.displayBorderRect.height}%`;
  }, [settings.displayBorderRect]);

  React.useEffect(() => {
    const preview = marginPreviewRef.current;
    if (!preview) {
      return undefined;
    }

    const updateSize = () => {
      setMarginPreviewSize({ width: preview.offsetWidth, height: preview.offsetHeight });
    };

    updateSize();

    const observer = new ResizeObserver(() => {
      updateSize();
    });
    observer.observe(preview);

    return () => {
      observer.disconnect();
    };
  }, []);

  const qrSizePx = marginPreviewSize.height > 0 ? marginPreviewSize.height * ((settings.qrCodeSizePercent ?? 15) / 100) : 0;
  const qrLeftPx = marginPreviewSize.width > 0 ? marginPreviewSize.width * ((settings.qrCodeX ?? 85) / 100) : 0;
  const qrTopPx = marginPreviewSize.height > 0 ? marginPreviewSize.height * ((settings.qrCodeY ?? 82) / 100) : 0;
  const qrPreviewUrl = "https://praiseprojector.local/display";

  React.useEffect(() => {
    const qrEl = marginPreviewQrRef.current;
    if (!qrEl || !settings.qrCodeInPreview) {
      return;
    }
    qrEl.style.left = `${qrLeftPx}px`;
    qrEl.style.top = `${qrTopPx}px`;
    qrEl.style.width = `${qrSizePx}px`;
    qrEl.style.height = `${qrSizePx}px`;
  }, [qrLeftPx, qrSizePx, qrTopPx, settings.qrCodeInPreview]);

  React.useEffect(() => {
    const qrEl = marginPreviewQrRef.current;
    if (!qrEl) {
      return undefined;
    }

    const handleNativeWheel = (event: WheelEvent) => {
      if (!settings.qrCodeInPreview) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY > 0 ? -2 : 2;
      updateQrSize((settings.qrCodeSizePercent ?? 15) + delta);
    };

    qrEl.addEventListener("wheel", handleNativeWheel, { passive: false, capture: true });

    return () => {
      qrEl.removeEventListener("wheel", handleNativeWheel, true);
    };
  }, [settings.qrCodeInPreview, settings.qrCodeSizePercent, updateQrSize]);

  return (
    <div className="container-fluid general-settings-root">
      <div className="row">
        <div className="col-md-6 general-settings-left-col">
          <div className="form-check mt-3 mt-md-0">
            <input
              className="form-check-input"
              type="checkbox"
              id="enableExternalWebDisplay"
              checked={settings.externalWebDisplayEnabled}
              onChange={(e) => updateSetting("externalWebDisplayEnabled", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="enableExternalWebDisplay">
              {t("SettingsExternalWebDisplay")}
            </label>
          </div>

          <div className="form-group mt-3 non-breaking-words-group">
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="useNonBreakingWords"
                checked={settings.useNonSplittingWords}
                onChange={(e) => updateSetting("useNonSplittingWords", e.target.checked)}
              />
              <label className="form-check-label" htmlFor="useNonBreakingWords">
                {t("SettingsUseNonBreakingWords")}
              </label>
            </div>
            <textarea
              className="form-control"
              id="nonBreakingWordsList"
              placeholder={t("SettingsNonBreakingWordsPlaceholder")}
              value={settings.nonSplittingWordList.join("\n")}
              onChange={(e) => updateSetting("nonSplittingWordList", e.target.value.split("\n"))}
              disabled={!settings.useNonSplittingWords}
            ></textarea>
          </div>
        </div>

        <div className="col-md-6 general-settings-right-col">
          <div className="border p-2 margin-fieldset">
            <div className="margin-editor">
              <div className="margin-title">{t("SettingsLayout")}</div>
              <div className="margin-input-top margin-input">
                <label htmlFor="marginTop">{t("SettingsMarginTop")}</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  id="marginTop"
                  value={settings.displayBorderRect.top}
                  min={0}
                  max={MAX_MARGIN_SUM - settings.displayBorderRect.height}
                  onChange={handleMarginInputChange("top")}
                />
              </div>

              <div className="margin-input-left margin-input">
                <label htmlFor="marginLeft">{t("SettingsMarginLeft")}</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  id="marginLeft"
                  value={settings.displayBorderRect.left}
                  min={0}
                  max={MAX_MARGIN_SUM - settings.displayBorderRect.width}
                  onChange={handleMarginInputChange("left")}
                />
              </div>

              <div
                className={`margin-preview-box${draggingMarginHandle || draggingBox ? " is-dragging" : ""}${draggingBox ? " is-moving" : ""}`}
                ref={marginPreviewRef}
              >
                <div className="margin-preview-inner" ref={marginPreviewInnerRef} onPointerDown={startBoxDrag}>
                  <div className="margin-drag-dot margin-drag-dot-top" onPointerDown={startMarginDrag("top")} />
                  <div className="margin-drag-dot margin-drag-dot-right" onPointerDown={startMarginDrag("right")} />
                  <div className="margin-drag-dot margin-drag-dot-bottom" onPointerDown={startMarginDrag("bottom")} />
                  <div className="margin-drag-dot margin-drag-dot-left" onPointerDown={startMarginDrag("left")} />
                  <div className="margin-drag-dot margin-drag-dot-top-left" onPointerDown={startMarginDrag("top-left")} />
                  <div className="margin-drag-dot margin-drag-dot-top-right" onPointerDown={startMarginDrag("top-right")} />
                  <div className="margin-drag-dot margin-drag-dot-bottom-right" onPointerDown={startMarginDrag("bottom-right")} />
                  <div className="margin-drag-dot margin-drag-dot-bottom-left" onPointerDown={startMarginDrag("bottom-left")} />
                  <span className="margin-preview-text">Hallelujah!</span>
                </div>
                {settings.qrCodeInPreview && (
                  <div
                    ref={marginPreviewQrRef}
                    className={`margin-preview-qrcode${isQrDragging ? " is-dragging" : ""}`}
                    onPointerDown={startQrDrag}
                    onWheel={handleQrWheel}
                    title={t("SettingsQRCodePreviewHelp")}
                  >
                    <div dangerouslySetInnerHTML={{ __html: generateQRCodeSVG(qrPreviewUrl, Math.max(16, Math.round(qrSizePx))) }} />
                  </div>
                )}
              </div>

              <div className="margin-input-right margin-input">
                <label htmlFor="marginRight">{t("SettingsMarginRight")}</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  id="marginRight"
                  value={settings.displayBorderRect.width}
                  min={0}
                  max={MAX_MARGIN_SUM - settings.displayBorderRect.left}
                  onChange={handleMarginInputChange("right")}
                />
              </div>

              <div className="margin-input-bottom margin-input">
                <label htmlFor="marginBottom">{t("SettingsMarginBottom")}</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  id="marginBottom"
                  value={settings.displayBorderRect.height}
                  min={0}
                  max={MAX_MARGIN_SUM - settings.displayBorderRect.top}
                  onChange={handleMarginInputChange("bottom")}
                />
              </div>
            </div>
            <div className="margin-preview-help text-muted">{t("SettingsMarginPreviewHelp")}</div>
          </div>
        </div>
        <div className="col-12">
          <hr />
          <div className="form-check mt-1">
            <input
              className="form-check-input"
              type="checkbox"
              id="qrCodeInPreview"
              checked={settings.qrCodeInPreview}
              onChange={(e) => updateSetting("qrCodeInPreview", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="qrCodeInPreview">
              {t("SettingsQRCodeVisible")}
            </label>
          </div>
          {settings.qrCodeInPreview && (
            <div className="shadow-controls mt-3 ps-4 border-start border-2 border-secondary">
              <div className="row g-2 mt-1 qr-settings-inputs">
                <div className="col-12">
                  <label className="form-label mb-1" htmlFor="qrCodeSizeSlider">
                    {t("SettingsQRCodeSize")}
                  </label>
                  <SafeSlider
                    id="qrCodeSizeSlider"
                    className="form-range"
                    min={1}
                    max={100}
                    step={1}
                    value={settings.qrCodeSizePercent}
                    aria-label={t("SettingsQRCodeSize")}
                    onChange={(e) => updateQrSize(parseInt(e.target.value || "0", 10))}
                  />
                  <small className="text-muted d-block mt-1">
                    {t("SettingsQRCodeSizeHelp")} ({Math.round(settings.qrCodeSizePercent)}%)
                  </small>
                </div>
                <div className="col-12">
                  <label className="form-label mb-1" htmlFor="qrCodeXSlider">
                    {t("SettingsQRCodeX")}
                  </label>
                  <SafeSlider
                    id="qrCodeXSlider"
                    className="form-range"
                    min={0}
                    max={100}
                    step={1}
                    value={settings.qrCodeX}
                    onChange={(e) => updateQrAxis("x", parseInt(e.target.value || "0", 10))}
                  />
                  <small className="text-muted d-block mt-1">
                    {t("SettingsQRCodeXPositionHelp")} ({Math.round(settings.qrCodeX)}%)
                  </small>
                </div>

                <div className="col-12">
                  <label className="form-label mb-1" htmlFor="qrCodeYSlider">
                    {t("SettingsQRCodeY")}
                  </label>
                  <SafeSlider
                    id="qrCodeYSlider"
                    className="form-range"
                    min={0}
                    max={100}
                    step={1}
                    value={settings.qrCodeY}
                    onChange={(e) => updateQrAxis("y", parseInt(e.target.value || "0", 10))}
                  />
                  <small className="text-muted d-block mt-1">
                    {t("SettingsQRCodeYPositionHelp")} ({Math.round(settings.qrCodeY)}%)
                  </small>
                </div>
              </div>
              <div className="small text-muted mt-1">{t("SettingsQRCodePreviewHelp")}</div>
            </div>
          )}
          <div className="form-group mt-3 shadow-settings-group">
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="displayTextShadowEnabled"
                checked={settings.displayTextShadowEnabled}
                onChange={(e) => updateSetting("displayTextShadowEnabled", e.target.checked)}
              />
              <label className="form-check-label" htmlFor="displayTextShadowEnabled">
                {t("SettingsTextShadowEnabled")}
              </label>
            </div>

            {settings.displayTextShadowEnabled && (
              <div className="shadow-controls mt-3 ps-4 border-start border-2 border-secondary">
                <div className="form-group">
                  <label htmlFor="displayTextShadowOffset">{t("SettingsTextShadowOffset")}</label>
                  <SafeSlider
                    className="form-range"
                    id="displayTextShadowOffset"
                    min={0}
                    max={20}
                    step={1}
                    value={settings.displayTextShadowOffset}
                    onChange={(e) => updateSetting("displayTextShadowOffset", parseInt(e.target.value, 10))}
                  />
                  <small className="text-muted d-block mt-1">
                    {t("SettingsTextShadowOffsetHelp")} ({settings.displayTextShadowOffset}px)
                  </small>
                </div>

                <div className="form-group mt-3">
                  <label htmlFor="displayTextShadowBlur">{t("SettingsTextShadowBlur")}</label>
                  <SafeSlider
                    className="form-range"
                    id="displayTextShadowBlur"
                    min={0}
                    max={20}
                    step={1}
                    value={settings.displayTextShadowBlur}
                    onChange={(e) => updateSetting("displayTextShadowBlur", parseInt(e.target.value, 10))}
                  />
                  <small className="text-muted d-block mt-1">
                    {t("SettingsTextShadowBlurHelp")} ({settings.displayTextShadowBlur}px)
                  </small>
                </div>

                <div className="form-group mt-3">
                  <label htmlFor="displayTextShadowColor">{t("SettingsTextShadowColor")}</label>
                  <input
                    type="color"
                    className="form-control form-control-color"
                    id="displayTextShadowColor"
                    value={settings.displayTextShadowColor}
                    onChange={(e) => updateSetting("displayTextShadowColor", e.target.value)}
                  />
                  <small className="text-muted d-block mt-1">{t("SettingsTextShadowColorHelp")}</small>
                </div>

                <div className="form-group mt-3">
                  <label htmlFor="displayTextShadowOpacity">{t("SettingsTextShadowOpacity")}</label>
                  <SafeSlider
                    className="form-range"
                    id="displayTextShadowOpacity"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(settings.displayTextShadowOpacity * 100)}
                    onChange={(e) => updateSetting("displayTextShadowOpacity", parseInt(e.target.value, 10) / 100)}
                  />
                  <small className="text-muted d-block mt-1">
                    {t("SettingsTextShadowOpacityHelp")} ({Math.round(settings.displayTextShadowOpacity * 100)}%)
                  </small>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProjectingSettings;
