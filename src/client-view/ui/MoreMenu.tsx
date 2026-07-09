/**
 * MoreMenu — the overflow menu (menu.svg) in the options-panel header, mirroring
 * the legacy index.html #btnMore dropdown (save / online / report /
 * power / about). Each item is gated off a capability so the same menu degrades
 * gracefully across the served, cloud and embedded contexts:
 *
 *   - Sync             → always (refresh backend-derived collections / follow)
 *   - Open full editor → capabilities.canOpenFullEditor (browser/desktop only)
 *   - Clear list       → playlist editor mode (confirm, disabled when empty)
 *   - Save list        → capabilities.canPersistPlaylist (leader/profile target)
 *   - About            → always
 *   - Exit             → state.canExit (native host shells only)
 *
 * Behaviour-only items dispatch a controller action; nothing here touches the
 * backend directly.
 */

import { useEffect, useRef, useState } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { canUseSessions, hasFullViewTodo } from "../controller/ClientViewStore";
import { icon } from "./assets";

interface MenuItem {
  id: string;
  label: string;
  image: string;
  show: boolean;
  /** Greyed-out but visible (legacy makeDisabled), e.g. Clear/Save on an empty list. */
  disabled?: boolean;
  /** Show a red attention dot on this item (full-view todo pending). */
  dot?: boolean;
  run: () => void;
}

export function MoreMenu({ onHome }: { onHome?: () => void }) {
  const store = useClientViewStore();
  const state = useClientViewState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on an outside click / tap (the legacy menu closes the same way).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const caps = state.capabilities;
  const items: MenuItem[] = [
    // Account: the cloud-only affordances (canLogin is false for the host-gated
    // served client and the desktop embed).
    // Sign in anbd out disabled for now
    /*    
    { id: "signin", label: "Sign in", image: "enter.svg", show: caps.canLogin && !state.authed, run: () => store.openLoginDialog() },
    {
      id: "signout",
      label: state.leader ? `Sign out (${state.leader.name})` : "Sign out",
      image: "exit.svg",
      show: caps.canLogin && state.authed,
      run: () => void store.logout(),
    },
*/
    {
      id: "clear-list",
      label: "Clear list",
      image: "clear.svg",
      show: caps.canEditWorkingPlaylist,
      disabled: state.playlist.length === 0,
      run: () => void store.clearPlaylist(),
    },
    // Sessions hub — discover/attach + host controls live in the shared SessionsForm dialog.
    // App-mode only: Client mode is a fixed-source follower with no sessions hub.
    { id: "sessions", label: "Sessions", image: "wifi.svg", show: canUseSessions(state), run: () => store.openSessionsDialog() },
    {
      id: "home",
      label: "Switch UI",
      image: "full-ui.svg",
      show: Boolean(onHome) || caps.canOpenFullEditor,
      dot: hasFullViewTodo(state),
      run: () => {
        if (onHome) onHome();
        else store.openFullEditor();
      },
    },
    { id: "about", label: "About", image: "about.svg", show: true, run: () => store.openAbout() },
    { id: "exit", label: "Exit", image: "power.svg", show: state.canExit, run: () => store.exitApp() },
  ];
  const visible = items.filter((item) => item.show);
  if (visible.length === 0) return null;

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    item.run();
  };

  return (
    <div className="cv-more" ref={rootRef}>
      <button
        type="button"
        className="cv-iconbtn cv-more-btn"
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <img className="btnImg cv-opt-icon" src={icon("menu.svg")} alt="More" />
        {hasFullViewTodo(state) && <span className="cv-todo-dot" aria-label="Action needed in full view" />}
      </button>
      {open && (
        <div className="cv-more-menu" role="menu">
          {visible.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="cv-more-item"
              disabled={item.disabled}
              onClick={() => choose(item)}
              title={item.label}
            >
              <img className="btnImg cv-opt-icon" src={icon(item.image)} alt="" />
              {item.dot && <span className="cv-todo-dot" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
