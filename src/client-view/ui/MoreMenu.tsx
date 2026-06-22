/**
 * MoreMenu — the overflow menu (menu.svg) in the options-panel header, mirroring
 * the legacy index.html #btnMore dropdown (clear list / save / online / report /
 * power / about). Each item is gated off a capability so the same menu degrades
 * gracefully across the served, cloud and embedded contexts:
 *
 *   - Open full editor → capabilities.canOpenFullEditor (browser/desktop only)
 *   - Save list        → capabilities.canPersistPlaylist (cloud leader)
 *   - Clear list       → capabilities.canEditWorkingPlaylist
 *   - About            → always
 *   - Exit             → state.canExit (native host shells only)
 *
 * Behaviour-only items dispatch a controller action; nothing here touches the
 * backend directly.
 */

import { useEffect, useRef, useState } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { icon } from "./assets";

interface MenuItem {
  id: string;
  label: string;
  image: string;
  show: boolean;
  /** Greyed-out but visible (legacy makeDisabled), e.g. Clear/Save on an empty list. */
  disabled?: boolean;
  run: () => void;
}

export function MoreMenu() {
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
  // Clear/Save act on the live working playlist; greyed out while it is empty
  // (legacy makeDisabled(iconClearList, playlist.length === 0)).
  const emptyList = state.playlist.length === 0;
  const items: MenuItem[] = [
    // Account + session: the cloud-only affordances (canLogin / canFollowSessions
    // are false for the host-gated served client and the desktop embed).
    { id: "signin", label: "Sign in", image: "user.svg", show: caps.canLogin && !state.authed, run: () => store.openLoginDialog() },
    {
      id: "signout",
      label: state.leader ? `Sign out (${state.leader.name})` : "Sign out",
      image: "exit.svg",
      show: caps.canLogin && state.authed,
      run: () => void store.logout(),
    },
    { id: "sessions", label: "Follow a session", image: "online.svg", show: caps.canFollowSessions, run: () => store.openSessionsDialog() },
    { id: "editor", label: "Open editor", image: "edit-instructions.svg", show: caps.canOpenFullEditor, run: () => store.openFullEditor() },
    {
      id: "save",
      label: "Save list",
      image: "store.svg",
      show: caps.canPersistPlaylist,
      disabled: emptyList,
      run: () => void store.openSaveDialog(),
    },
    {
      id: "clear",
      label: "Clear list",
      image: "clear.svg",
      show: caps.canEditWorkingPlaylist,
      disabled: emptyList,
      run: () => void store.clearPlaylist(),
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
      </button>
      {open && (
        <div className="cv-more-menu" role="menu">
          {visible.map((item) => (
            <button key={item.id} type="button" role="menuitem" className="cv-more-item" disabled={item.disabled} onClick={() => choose(item)}>
              <img className="btnImg cv-opt-icon" src={icon(item.image)} alt="" />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
