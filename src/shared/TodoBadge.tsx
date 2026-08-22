/**
 * TodoBadge — the attention dot that reports outstanding work, colour-coded by
 * WHAT is outstanding (see TodoBadgeKind in state/syncStatusStore).
 *
 * Shared between the client-view (options / more buttons and the more-menu items)
 * and the full-view paging-mode tab header (App.tsx) — Electron-free and
 * presentational only, like the other components in src/shared/. Both surfaces
 * must agree on the colours, so there is exactly ONE dot implementation and one
 * stylesheet; classifying is syncStatusStore's job, not the view's.
 *
 * The dot is absolutely positioned in its parent's top-right corner, so every
 * host element must establish a positioning context of its own.
 */

import { todoBadgeKind, useSyncStatus, type TodoBadgeKind } from "../state/syncStatusStore";
import "./TodoBadge.css";

export function TodoBadge({ kind, label }: { kind: TodoBadgeKind; label?: string }) {
  return <span className={`cv-todo-dot cv-todo-dot-${kind}`} aria-label={label} aria-hidden={label ? undefined : true} />;
}

/**
 * The full view's own badge: subscribes to the shared sync status itself so its
 * host (App's tab header) is not re-rendered by every status change.
 *
 * `ignoreUpdate` is set by the tab header — an available app update is offered by
 * UpdateNotification above all three tabs, so it must not badge one of them.
 */
export function SyncTodoBadge({ ignoreUpdate, label }: { ignoreUpdate?: boolean; label?: string }) {
  const kind = todoBadgeKind(useSyncStatus(), { ignoreUpdate });
  return kind ? <TodoBadge kind={kind} label={label} /> : null;
}
