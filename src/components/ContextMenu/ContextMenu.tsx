import React, { useEffect } from "react";
import { useMenuViewportFit } from "./menuPlacement";
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
  // Keeps the whole menu inside the client area, and scrolls it when it cannot fit.
  const { ref: menuRef, style } = useMenuViewportFit<HTMLDivElement>({ x: position.x, y: position.y }, { maxWidth, maxHeight });

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
  }, [onClose, menuRef]);

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.disabled) return;
    onSelect(item.value);
    onClose();
  };

  return (
    <div ref={menuRef} className="context-menu" style={style}>
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
