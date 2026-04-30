import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { LogEntry } from "../types/electron.d";
import { useLocalization } from "../localization/LocalizationContext";
import "./LogViewerPage.css";

// ── Object tree rendering (shared logic with LogViewer) ──────────────────────

interface ObjectNodeProps {
  name?: string;
  value: unknown;
  defaultExpanded?: boolean;
  depth?: number;
}

const ObjectNode: React.FC<ObjectNodeProps> = ({ name, value, defaultExpanded = false, depth = 0 }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const toggle = useCallback(() => setExpanded((e) => !e), []);

  if (value === null)
    return (
      <span className="lvp-obj-leaf">
        {name != null && <span className="lvp-obj-key">{name}: </span>}
        <span className="lvp-obj-null">null</span>
      </span>
    );
  if (value === undefined)
    return (
      <span className="lvp-obj-leaf">
        {name != null && <span className="lvp-obj-key">{name}: </span>}
        <span className="lvp-obj-null">undefined</span>
      </span>
    );

  if (typeof value === "object" && !(value instanceof Date)) {
    const isArray = Array.isArray(value);
    const entries = isArray ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
    const preview = isArray
      ? `Array(${entries.length})`
      : `{${entries
          .slice(0, 3)
          .map(([k]) => k)
          .join(", ")}${entries.length > 3 ? ", …" : ""}}`;

    if (entries.length === 0) {
      return (
        <span className="lvp-obj-leaf">
          {name != null && <span className="lvp-obj-key">{name}: </span>}
          {isArray ? "[]" : "{}"}
        </span>
      );
    }

    return (
      <span className="lvp-obj-node">
        <span className="lvp-obj-toggle" onClick={toggle}>
          {expanded ? "▼" : "▶"}
        </span>
        {name != null && (
          <span className="lvp-obj-key" onClick={toggle}>
            {name}:{" "}
          </span>
        )}
        {!expanded && (
          <span className="lvp-obj-preview" onClick={toggle}>
            {preview}
          </span>
        )}
        {expanded && (
          <span className="lvp-obj-children">
            {isArray ? "[" : "{"}
            {entries.map(([k, v]) => (
              <span key={k} className="lvp-obj-child" data-depth={depth + 1}>
                <ObjectNode name={isArray ? `[${k}]` : k} value={v} depth={depth + 1} />
              </span>
            ))}
            {isArray ? "]" : "}"}
          </span>
        )}
      </span>
    );
  }

  const cls =
    typeof value === "string"
      ? "lvp-obj-string"
      : typeof value === "number"
        ? "lvp-obj-number"
        : typeof value === "boolean"
          ? "lvp-obj-bool"
          : "lvp-obj-other";
  const display = typeof value === "string" ? `"${value}"` : String(value);

  return (
    <span className="lvp-obj-leaf">
      {name != null && <span className="lvp-obj-key">{name}: </span>}
      <span className={cls}>{display}</span>
    </span>
  );
};

const ArgRenderer: React.FC<{ arg: unknown; index: number; autoExpand?: boolean }> = ({ arg, index, autoExpand = false }) => {
  if (arg === null || arg === undefined)
    return (
      <>
        {index > 0 ? " " : ""}
        <span className="lvp-obj-null">{String(arg)}</span>
      </>
    );
  if (typeof arg !== "object")
    return (
      <>
        {index > 0 ? " " : ""}
        {String(arg)}
      </>
    );
  return (
    <>
      {index > 0 ? " " : ""}
      <ObjectNode value={arg} defaultExpanded={autoExpand} />
    </>
  );
};

// ── Helpers ──────────────────────────────────────────────────────────────────

let uidCounter = 0;
function nextUid(): string {
  return `lvp-${++uidCounter}`;
}

interface TaggedLogEntry extends LogEntry {
  uid: string;
}

interface DisplayLogEntry extends TaggedLogEntry {
  originalIndex: number;
  isPinned?: boolean;
}

/** Map level strings to numeric severity (higher = more severe) */
const LEVEL_SEVERITY: Record<string, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };

/** Highlight occurrences of `term` within `text` */
function highlightText(text: string, term: string): React.ReactNode {
  if (!term) return text;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="lvp-filter-highlight">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function getFirstLine(message: string): string {
  const nl = message.indexOf("\n");
  return nl >= 0 ? message.substring(0, nl) : message;
}

// ── LogViewerPage Component ──────────────────────────────────────────────────

const LogViewerPage: React.FC = () => {
  const { t } = useLocalization();

  // Set window title
  useEffect(() => {
    document.title = t("LogViewer");
  }, [t]);

  const [logs, setLogs] = useState<TaggedLogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [autoExpandParams, setAutoExpandParams] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const selectedRowRef = useRef<HTMLTableRowElement>(null);

  // Load initial logs
  useEffect(() => {
    const loadLogs = async () => {
      if (window.electronAPI?.logs) {
        const initialLogs = await window.electronAPI.logs.get();
        setLogs(initialLogs.map((e) => ({ ...e, uid: nextUid() })));
      }
    };
    loadLogs();
  }, []);

  // Subscribe to new log entries
  useEffect(() => {
    if (!window.electronAPI?.logs) return;
    const unsubscribe = window.electronAPI.logs.onEntry((entry: LogEntry) => {
      setLogs((prev) => [...prev, { ...entry, uid: nextUid() }]);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleClear = async () => {
    if (window.electronAPI?.logs) {
      await window.electronAPI.logs.clear();
      setLogs([]);
      setExpandedRows(new Set());
    }
  };

  const handleRefresh = async () => {
    if (window.electronAPI?.logs) {
      const refreshedLogs = await window.electronAPI.logs.get();
      setLogs(refreshedLogs.map((e) => ({ ...e, uid: nextUid() })));
    }
  };

  const formatTimestamp = (timestamp: number): string => {
    const date = new Date(timestamp);
    return (
      date.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }) +
      "." +
      date.getMilliseconds().toString().padStart(3, "0")
    );
  };

  const getLevelClass = (level: string): string => {
    switch (level) {
      case "error":
        return "lvp-level-error";
      case "warn":
        return "lvp-level-warn";
      case "info":
        return "lvp-level-info";
      case "debug":
        return "lvp-level-debug";
      default:
        return "lvp-level-log";
    }
  };

  const toggleExpand = useCallback((uid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const handleRowClick = useCallback((originalIndex: number) => {
    setSelectedIndex((prev) => (prev === originalIndex ? null : originalIndex));
    setAutoScroll(false);
  }, []);

  // Build display list: filtered logs + pinned selected row
  const displayLogs: DisplayLogEntry[] = useMemo(() => {
    const result: DisplayLogEntry[] = [];
    let selectedIncluded = false;
    const minSeverity = levelFilter === "all" ? -1 : (LEVEL_SEVERITY[levelFilter] ?? -1);

    logs.forEach((log, originalIndex) => {
      const matchesLevel = minSeverity < 0 || (LEVEL_SEVERITY[log.level] ?? 0) >= minSeverity;
      const matchesSource = sourceFilter === "all" || (log.source ?? "backend") === sourceFilter;
      const matchesText = filter === "" || log.message.toLowerCase().includes(filter.toLowerCase());

      if (matchesLevel && matchesSource && matchesText) {
        result.push({ ...log, originalIndex });
        if (originalIndex === selectedIndex) selectedIncluded = true;
      }
    });

    if (selectedIndex !== null && !selectedIncluded && selectedIndex < logs.length) {
      const pinnedLog: DisplayLogEntry = { ...logs[selectedIndex], originalIndex: selectedIndex, isPinned: true };
      let insertPos = result.findIndex((l) => l.originalIndex > selectedIndex);
      if (insertPos === -1) insertPos = result.length;
      result.splice(insertPos, 0, pinnedLog);
    }

    return result;
  }, [logs, filter, levelFilter, sourceFilter, selectedIndex]);

  const handleCopyVisibleLogs = useCallback(async () => {
    const lines = displayLogs.map((log) => {
      const source = (log.source ?? "backend") === "frontend" ? "FE" : "BE";
      return `${formatTimestamp(log.timestamp)}\t${source}\t${log.level.toUpperCase()}\t${log.message}`;
    });

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch (error) {
      console.error("Failed to copy visible logs:", error);
    }
  }, [displayLogs]);

  // Scroll selected row into view when filter changes
  useEffect(() => {
    if (selectedRowRef.current) {
      selectedRowRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [filter, levelFilter, sourceFilter]);

  /** Render text with filter highlighting */
  const hl = useCallback((text: string) => highlightText(text, filter), [filter]);

  const renderMessage = useCallback(
    (log: DisplayLogEntry) => {
      const expanded = expandedRows.has(log.uid);
      const hasObjectArgs = log.args?.some((a) => a !== null && a !== undefined && typeof a === "object");
      const hasMultiline = log.message.includes("\n");

      // Object args: render all args inline (string args as text, objects as ObjectNode)
      // Don't use log.message here — it already contains stringified objects which would duplicate the ObjectNode output.
      if (hasObjectArgs && log.args) {
        return (
          <span className="lvp-msg-text">
            {log.args.map((arg, i) => (
              <ArgRenderer key={i} arg={arg} index={i} autoExpand={autoExpandParams} />
            ))}
          </span>
        );
      }

      // Multiline messages: use row-level expand/collapse
      if (hasMultiline) {
        if (!expanded) {
          return (
            <span className="lvp-msg-collapsed">
              <span className="lvp-expand-toggle" onClick={(e) => toggleExpand(log.uid, e)} title="Click to expand">
                ▶
              </span>
              <span className="lvp-msg-text">{hl(getFirstLine(log.message))}</span>
              <span className="lvp-msg-more"> …</span>
            </span>
          );
        }
        return (
          <span className="lvp-msg-expanded">
            <span className="lvp-expand-toggle" onClick={(e) => toggleExpand(log.uid, e)} title="Click to collapse">
              ▼
            </span>
            <pre className="lvp-message-pre">{hl(log.message)}</pre>
          </span>
        );
      }

      // Simple single-line, no object args
      return <span className="lvp-msg-text">{hl(log.message)}</span>;
    },
    [expandedRows, toggleExpand, autoExpandParams, hl]
  );

  return (
    <div className="lvp-container">
      <div className="lvp-toolbar">
        <input
          type="text"
          className="form-control lvp-filter-input"
          placeholder={t("FilterLogs")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="form-select lvp-level-select"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          title={t("Level")}
          aria-label={t("Level")}
        >
          <option value="all">{t("AllLevels")}</option>
          <option value="error">{t("ErrorAndAbove")}</option>
          <option value="warn">{t("WarnAndAbove")}</option>
          <option value="info">{t("InfoAndAbove")}</option>
          <option value="log">{t("LogAndAbove")}</option>
          <option value="debug">{t("Debug")}</option>
        </select>
        <select
          className="form-select lvp-level-select"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          title="Source"
          aria-label="Source"
        >
          <option value="all">{t("AllSources")}</option>
          <option value="frontend">{t("Frontend")}</option>
          <option value="backend">{t("Backend")}</option>
        </select>
        <label className="lvp-autoscroll-check">
          <input type="checkbox" checked={autoExpandParams} onChange={(e) => setAutoExpandParams(e.target.checked)} />
          {t("SettingsLogAutoExpandParams")}
        </label>
        <label className="lvp-autoscroll-check">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          {t("AutoScroll")}
        </label>
        <button className="btn btn-outline-secondary btn-sm" onClick={handleRefresh}>
          {t("Refresh")}
        </button>
        <button className="btn btn-outline-secondary btn-sm" onClick={() => void handleCopyVisibleLogs()} disabled={displayLogs.length === 0}>
          {t("CopyVisible")}
        </button>
        <button className="btn btn-outline-danger btn-sm" onClick={handleClear}>
          {t("ClearLogs")}
        </button>
      </div>
      <div className="lvp-body" ref={logContainerRef}>
        {displayLogs.length === 0 ? (
          <div className="lvp-empty-message">{t("NoLogs")}</div>
        ) : (
          <table className="lvp-table">
            <thead>
              <tr>
                <th className="lvp-col-time">{t("Time")}</th>
                <th className="lvp-col-source">Src</th>
                <th className="lvp-col-level">{t("Level")}</th>
                <th className="lvp-col-message">{t("Message")}</th>
              </tr>
            </thead>
            <tbody>
              {displayLogs.map((log, displayIndex) => {
                const isSelected = log.originalIndex === selectedIndex;
                return (
                  <tr
                    key={log.uid}
                    data-display-index={displayIndex}
                    ref={isSelected ? selectedRowRef : null}
                    className={`${getLevelClass(log.level)}${isSelected ? " lvp-row-selected" : ""}${log.isPinned ? " lvp-row-pinned" : ""}`}
                    onClick={() => handleRowClick(log.originalIndex)}
                  >
                    <td className="lvp-col-time">{formatTimestamp(log.timestamp)}</td>
                    <td className={`lvp-col-source lvp-source-${log.source ?? "backend"}`}>
                      {log.isPinned && (
                        <span className="lvp-pinned-indicator" title="Pinned (doesn't match filter)">
                          📌{" "}
                        </span>
                      )}
                      {(log.source ?? "backend") === "frontend" ? "FE" : "BE"}
                    </td>
                    <td className="lvp-col-level">{log.level.toUpperCase()}</td>
                    <td className="lvp-col-message">{renderMessage(log)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="lvp-footer">
        <span className="lvp-count">
          {t("LogCount")}: {displayLogs.length} / {logs.length}
          {selectedIndex !== null && ` • Selected: #${selectedIndex + 1}`}
        </span>
      </div>
    </div>
  );
};

export default LogViewerPage;
