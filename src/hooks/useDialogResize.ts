import React, { useState, useEffect, RefObject } from "react";

interface ResizeStart {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * Hook that provides center-based resize behaviour for floating dialogs.
 *
 * When the user drags the resize handle the dialog expands equally in both
 * directions (left/right and up/down) so that it grows around its centre
 * point.  The resulting position and size are always clamped so the dialog
 * stays fully within the visible viewport.
 *
 * @param dialogRef   Ref to the dialog root element.
 * @param disabled    When true the resize handle does nothing (e.g. while
 *                    maximised or on mobile).
 */
export function useDialogResize(dialogRef: RefObject<HTMLDivElement | null>, { disabled = false }: { disabled?: boolean } = {}) {
  const [isResizing, setIsResizing] = useState(false);
  const [resizeStart, setResizeStart] = useState<ResizeStart>({ x: 0, y: 0, width: 0, height: 0, left: 0, top: 0 });

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    if (disabled || !dialogRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = dialogRef.current.getBoundingClientRect();
    setResizeStart({
      x: e.clientX,
      y: e.clientY,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
    });
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;

    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (e: MouseEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      const dx = e.clientX - resizeStart.x;
      const dy = e.clientY - resizeStart.y;

      // Centre of the dialog at the moment the drag started.
      const centerX = resizeStart.left + resizeStart.width / 2;
      const centerY = resizeStart.top + resizeStart.height / 2;

      // Read CSS-computed minimum dimensions (respects rem→px conversion).
      const computedStyle = window.getComputedStyle(dialog);
      const minWidth = parseFloat(computedStyle.minWidth) || 200;
      const minHeight = parseFloat(computedStyle.minHeight) || 150;

      // Expand symmetrically: each edge moves by |delta| in its direction.
      let newWidth = Math.max(minWidth, resizeStart.width + 2 * dx);
      let newHeight = Math.max(minHeight, resizeStart.height + 2 * dy);

      // Never exceed the viewport.
      newWidth = Math.min(newWidth, window.innerWidth);
      newHeight = Math.min(newHeight, window.innerHeight);

      // Re-centre after clamping.
      let newLeft = centerX - newWidth / 2;
      let newTop = centerY - newHeight / 2;

      // Keep the dialog fully within the viewport.
      newLeft = Math.max(0, Math.min(window.innerWidth - newWidth, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - newHeight, newTop));

      // Override any CSS max-width/max-height so inline values take effect.
      dialog.style.maxWidth = "none";
      dialog.style.maxHeight = "none";
      dialog.style.width = `${newWidth}px`;
      dialog.style.height = `${newHeight}px`;
      dialog.style.left = `${newLeft}px`;
      dialog.style.top = `${newTop}px`;
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, resizeStart, dialogRef]);

  return { isResizing, handleResizeMouseDown };
}
