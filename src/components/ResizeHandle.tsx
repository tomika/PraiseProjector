import { PanelResizeHandle } from "react-resizable-panels";
import "./ResizeHandle.css";

interface ResizeHandleProps {
  className?: string;
  id?: string;
  disabled?: boolean;
}

export default function ResizeHandle({ className = "", id, disabled = false }: ResizeHandleProps) {
  return (
    <PanelResizeHandle
      className={["resize-handle-outer", disabled ? "resize-handle-disabled" : "", className].filter(Boolean).join(" ")}
      id={id ?? null}
      disabled={disabled}
    >
      <div className={"resize-handle-inner"} />
    </PanelResizeHandle>
  );
}
