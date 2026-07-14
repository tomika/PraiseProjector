import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./ContextMenu.css";

export interface ContextMenuItem {
  label: string;
  value: string;
  iconClass?: string;
  disabled?: boolean;
  separator?: boolean;
  shortcut?: string;
  /** Optional custom React content that replaces the default icon+label rendering */
  customContent?: React.ReactNode;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  maxHeight?: number;
  maxWidth?: number;
  onSelect: (value: string) => void;
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ items, position, maxHeight, maxWidth, onSelect, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const edgePadding = 4;
  const [resolvedPosition, setResolvedPosition] = useState(position);
  const [resolvedMaxHeight, setResolvedMaxHeight] = useState<number | undefined>(maxHeight);

  useEffect(() => {
    // Reset the resolved (measured) position/height back to the incoming props
    // whenever the menu is re-opened at a new anchor; the layout effect below
    // then re-measures. Deliberate prop->state resync, not a cascading loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResolvedPosition(position);
    setResolvedMaxHeight(maxHeight);
  }, [position, maxHeight]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const absoluteMaxHeight = Math.max(60, viewportHeight - edgePadding * 2);
    const nextMaxHeight = Math.min(maxHeight ?? absoluteMaxHeight, absoluteMaxHeight);

    const rect = menu.getBoundingClientRect();
    const renderedHeight = rect.height;
    const renderedWidth = rect.width;

    const spaceBelow = viewportHeight - edgePadding - position.y;
    const spaceAbove = position.y - edgePadding;

    let nextY = position.y;
    if (renderedHeight > spaceBelow && spaceAbove > spaceBelow) {
      // Raise only as much as needed to keep menu near click point.
      nextY = position.y - renderedHeight;
    }

    const maxY = viewportHeight - edgePadding - renderedHeight;
    if (maxY <= edgePadding) {
      nextY = edgePadding;
    } else {
      nextY = Math.min(Math.max(nextY, edgePadding), maxY);
    }

    const maxX = viewportWidth - edgePadding - renderedWidth;
    const nextX = maxX <= edgePadding ? edgePadding : Math.min(Math.max(position.x, edgePadding), maxX);

    const shouldUpdatePosition = Math.abs(resolvedPosition.x - nextX) > 0.5 || Math.abs(resolvedPosition.y - nextY) > 0.5;
    const shouldUpdateMaxHeight = resolvedMaxHeight !== nextMaxHeight;

    if (shouldUpdatePosition) {
      // Position derived from a real DOM measurement above (getBoundingClientRect)
      // inside a layout effect; the guard prevents re-runs, so no render loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResolvedPosition({ x: nextX, y: nextY });
    }
    if (shouldUpdateMaxHeight) {
      setResolvedMaxHeight(nextMaxHeight);
    }
  }, [items, position, maxHeight, resolvedPosition.x, resolvedPosition.y, resolvedMaxHeight]);

  useEffect(() => {
    const handlePointerOutside = (e: MouseEvent | TouchEvent | PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handlePointerOutside);
    document.addEventListener("touchstart", handlePointerOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerOutside);
      document.removeEventListener("touchstart", handlePointerOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.disabled) return;
    onSelect(item.value);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: `${resolvedPosition.x}px`,
        top: `${resolvedPosition.y}px`,
        maxHeight: resolvedMaxHeight ? `${resolvedMaxHeight}px` : undefined,
        maxWidth: maxWidth ? `${maxWidth}px` : undefined,
      }}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={index} className="context-menu-separator" role="separator" aria-hidden="true" />
        ) : (
          <div key={index} className={`context-menu-item ${item.disabled ? "disabled" : ""}`} onClick={() => handleItemClick(item)}>
            {item.customContent ? (
              item.customContent
            ) : (
              <>
                {item.iconClass && <i className={`context-menu-icon ${item.iconClass}`} aria-hidden="true"></i>}
                <span className="context-menu-label">{item.label}</span>
                {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
};
