/**
 * PageFlip — framework-agnostic page-turn gesture controller.
 *
 * The "page turn" is the 3D rotateY flip used to move between songs: three
 * stacked pages (current / prev / next) share a perspective container; a
 * horizontal swipe (or a forced {@link PageFlip.turn}) rotates the current page
 * around its edge, revealing the neighbour behind it, then advances the song.
 *
 * This is a faithful extraction of the algorithm that previously lived, twice,
 * in `src/components/ChordProEditor/ChordProEditor.tsx` (the desktop editor) and
 * `src/client-view/ui/SongView.tsx` (the servable client). Both now drive this
 * one controller. It is pure DOM — no React, no Database, no chordpro coupling —
 * so it stays importable from the servable client without pulling in the editor's
 * heavy dependencies.
 *
 * The host owns everything controller-external: the DOM/refs, the pointer/mouse
 * plumbing (it calls {@link PageFlip.handlePointer}), loading the neighbour song
 * content, and re-rendering the current song after a turn (it then calls
 * {@link PageFlip.finishPending}). Host-specific differences — the neighbour
 * paint strategy (display vs visibility), the clip boundary, and the
 * read-only/marking guards — are injected through {@link PageFlipConfig}.
 */

/** Drag state for an in-progress gesture (mirrors the original swipeState). */
interface SwipeState {
  dragX: number;
  dragY: number;
  direction: number;
  totalScroll: number;
  lastScroll?: number;
  startTime: number;
}

export interface PageFlipConfig {
  /** The perspective + clipping container hosting the three stacked pages. */
  container(): HTMLElement | null;
  /** The current page — the geometry source, the scroll host, and the element
   *  that rotates during a turn. */
  currentPage(): HTMLElement | null;
  /** The prev/next neighbour pages, revealed behind the current page. */
  prevPage(): HTMLElement | null;
  nextPage(): HTMLElement | null;
  /** Whether a neighbour exists in the given direction (true = forward/next). */
  hasNeighbour(next: boolean): boolean;
  /** Advance the projected song. The host loads the new song, then calls
   *  {@link PageFlip.finishPending} once it is in place. */
  onAdvance(next: boolean): void;
  /** Show/hide a neighbour page during a reveal. Hosts keep their own strategy
   *  (the desktop uses `display`, the client uses `visibility`) so neither
   *  layout model regresses. */
  setNeighbourVisible(page: HTMLElement, visible: boolean): void;
  /** Stop the overflow-unclipping walk *before* this ancestor (exclusive), so the
   *  rotating page is not clipped by intermediate panes but is still bounded by
   *  the host (e.g. the editor panel, or the client's full-view box). */
  isFlipBoundary(el: HTMLElement): boolean;
  /** Whether the flip is allowed at all (read-only, wired). False ⇒ gestures only
   *  scroll, never rotate. */
  canFlip(): boolean;
  /** Whether the editor is interactable for gestures — false while text is being
   *  selected/marked. */
  isInteractive(): boolean;
  /** Whether a chord-selector dialog is open (a turn is suppressed while it is). */
  isChordSelectorOpen(): boolean;
  /** Optional: let a tap on a chord box pre-empt the gesture (returns true when it
   *  handled the event). Present only where chord editing is offered. */
  handleChordBoxTouch?(e: PointerEvent | MouseEvent, down: boolean): boolean;
  /** Optional: host UI can fade/disable controls while a page is turning. */
  onFlipActiveChange?(active: boolean): void;
  /** Optional: lift only the turning page out of a clipped pane during the flip.
   *  The revealed neighbour stays clipped in the pane, while the current page and
   *  its shadow can overlap adjacent chrome. */
  liftCurrentPageDuringFlip?(): boolean;
}

export class PageFlip {
  /** Marker class added to the current page while it is turning so the CSS can
   *  hide that page's (and its descendants') scrollbar for the flip. The rule
   *  lives once in the shared `chordpro/pageFlip.css`, imported by both hosts. */
  static readonly HIDE_SCROLLBAR_CLASS = "pp-flip-hide-scrollbar";
  static readonly UNCLIP_PAGE_CLASS = "pp-flip-unclip-page";
  static readonly LIFTED_DARK_CLASS = "pp-flip-lifted-dark";
  static readonly SELECTION_GUARD_CLASS = "pp-flip-selection-guard";

  // ── page-turn shadow tunables ──────────────────────────────────────────────
  // The shadow is its own element (not a box-shadow), so horizontal reach,
  // height and fade-in are independent. A box-shadow couldn't do all three: its
  // offset is quadratic (so it only showed up late) and its size is a symmetric
  // spread on the page-sized clone (so trimming the height also killed the reach
  // and the deep perspective made it tower). Tune the four constants below.
  /** Shadow width at a full turn, as a fraction of the page width. */
  private static readonly SHADOW_REACH = 0.6;
  /** Shadow height, as a fraction of the page height. Kept < 1 so the perspective
   *  magnification of the lifted (near) edge lands it at roughly page height. */
  private static readonly SHADOW_HEIGHT = 0.9;
  /** Shadow tone (grey, matching the original) and its peak alpha at the spine. */
  private static readonly SHADOW_RGB = "70, 70, 70";
  private static readonly SHADOW_ALPHA = 1;
  /** Fraction of the reach over which the OUTER edge fades to transparent. The old
   *  box-shadow was a solid clone with just a soft boundary, so keep this small for
   *  a definite edge; raise it toward 1 for the full soft fade-out. */
  private static readonly SHADOW_EDGE_FADE = 0.25;

  private swipeState: SwipeState | null = null;
  private flipActive = false;
  /** Dedicated cast-shadow element, lazily created and parented to the container
   *  during a flip (the page's own overflow would clip a child, so it can't live
   *  on the page). Hidden in endFlip, removed in dispose. */
  private shadowEl: HTMLDivElement | null = null;
  private flipOverflowTargets: { el: HTMLElement; overflow: string }[] = [];
  private liftedPage: {
    page: HTMLElement;
    parent: Node;
    nextSibling: ChildNode | null;
    rect: DOMRect;
    style: {
      position: string;
      inset: string;
      left: string;
      top: string;
      width: string;
      height: string;
      zIndex: string;
      boxSizing: string;
      backgroundColor: string;
      color: string;
    };
  } | null = null;
  /** The current (rotating) page whose scrollbar is suppressed for the duration of
   *  a flip (via the {@link PageFlip.HIDE_SCROLLBAR_CLASS} marker), tracked so the
   *  exact element is un-marked in endFlip even if the current page has changed. */
  private scrollbarHidden: HTMLElement | null = null;
  private pendingReset = false;
  private pendingResetTimer: number | null = null;
  private animatingTurn = false;
  /** Generation token: bumped whenever the current gesture/animation is superseded
   *  (cancel, dispose, finishPending, a new pageTurn). The timer-driven phase loop
   *  captures the generation it was started under and stops itself the moment it
   *  no longer matches — so a cancelled turn can't keep rotating the page or fire
   *  a stale onAdvance afterwards. */
  private gestureGen = 0;

  constructor(private readonly cfg: PageFlipConfig) {}

  /** Whether a forced/release turn animation is currently in flight. Hosts may
   *  gate their own controls (e.g. toolbar buttons) on this. */
  get animating(): boolean {
    return this.animatingTurn;
  }

  /** Abort any in-progress gesture OR release animation (e.g. when a second finger
   *  touches down mid-swipe and pinch-zoom takes over). Must fully unwind whatever
   *  beginFlip()/pageTurn() already did — otherwise the page is left mid-rotation,
   *  still lifted out of the document flow, and flipActive stays true forever,
   *  blocking all future flips. Bumping the generation also stops an in-flight
   *  pageTurn phase loop, which previously kept animating (and advancing the song)
   *  after a cancel. */
  cancel(): void {
    this.gestureGen++;
    this.swipeState = null;
    if (this.pendingResetTimer !== null) {
      clearTimeout(this.pendingResetTimer);
      this.pendingResetTimer = null;
    }
    this.pendingReset = false;
    if (this.flipActive) this.snapBack();
    else this.animatingTurn = false;
  }

  /** Unwind a begun flip without navigating: reset the page's rotation, hide the
   *  neighbours and restore the clipping/lift state. Idempotent — the single exit
   *  used by every path that abandons a flip (release below the threshold, a
   *  gesture that ended without ownership, cancel, blocked pageTurn). */
  private snapBack(): void {
    const page = this.cfg.currentPage();
    if (page) {
      page.style.transform = "";
      page.style.border = "none";
      page.style.boxShadow = "";
    }
    this.hideNeighbours();
    this.endFlip();
    this.animatingTurn = false;
  }

  /** Tear down timers (call from the host's unmount/dispose). */
  dispose(): void {
    this.gestureGen++; // stop any in-flight phase loop
    if (this.pendingResetTimer !== null) {
      clearTimeout(this.pendingResetTimer);
      this.pendingResetTimer = null;
    }
    this.swipeState = null;
    if (this.shadowEl) {
      this.shadowEl.remove();
      this.shadowEl = null;
    }
    if (this.scrollbarHidden) {
      this.scrollbarHidden.classList.remove(PageFlip.HIDE_SCROLLBAR_CLASS, PageFlip.UNCLIP_PAGE_CLASS);
      this.scrollbarHidden = null;
    }
    this.restoreLiftedPage();
  }

  /** Forced animated turn for the host's Prev/Next controls. */
  turn(next: boolean): void {
    if (this.animatingTurn || !this.cfg.hasNeighbour(next)) return;
    this.pageTurn(next ? -1 : 1, 100, 200, true);
  }

  // ── gesture handling ────────────────────────────────────────────────────────

  /** Pointer/mouse entry point the host's input plumbing forwards to. */
  handlePointer(type: "down" | "up" | "move", e: PointerEvent | MouseEvent): void {
    const isPointerMouse = typeof PointerEvent !== "undefined" && e instanceof PointerEvent && e.pointerType === "mouse";
    let shouldPreventDefault = !isPointerMouse;

    // While a release animation runs — or a completed turn waits for the host's
    // reload (pendingReset) — new input is ignored wholesale. Feeding it into the
    // gesture state used to spawn a second concurrent phase loop (double turn) or
    // fight the animation's transform writes, both of which could leave the page
    // stranded mid-rotation.
    if (this.animatingTurn || this.pendingReset) {
      if (type === "up") this.swipeState = null;
      if (shouldPreventDefault) e.preventDefault();
      return;
    }

    const x = e.clientX;
    const y = e.clientY;

    // A tap on a chord box pre-empts the gesture (chord-editing hosts only).
    if (
      this.cfg.handleChordBoxTouch &&
      type !== "move" &&
      this.cfg.isInteractive() &&
      (!this.swipeState || this.swipeState.direction === 0) &&
      this.cfg.handleChordBoxTouch(e, type === "down")
    ) {
      this.swipeState = null;
      e.preventDefault();
      return;
    }

    // The chord-selector modal also disables flipping HERE (not only in pageTurn):
    // otherwise a drag rotates the page but the release is refused, wedging the
    // page half-turned with no owner. With the flip disabled the gesture falls
    // through to plain scrolling while the modal is up.
    const pageFlipEnabled = this.cfg.canFlip() && this.cfg.isInteractive() && !this.cfg.isChordSelectorOpen();
    // The current page is the geometry source, the scroll container and the
    // element that rotates (exactly like praiseprojector.ts).
    const el = this.cfg.currentPage();

    if (el) {
      switch (type) {
        case "down":
          this.swipeState = { dragX: x, dragY: y, direction: 0, totalScroll: 0, startTime: Date.now() };
          break;
        case "up": {
          const s = this.swipeState;
          if (s) {
            const offsetX = x - s.dragX;
            if (offsetX !== 0) {
              const direction = offsetX / Math.abs(offsetX);
              if (s.direction && s.direction * direction >= 0) {
                shouldPreventDefault = true;
                // Viewport coords so the pivot/scale are correct regardless of
                // where the host sits (drag coords are clientX-based).
                const rect = el.getBoundingClientRect();
                const left = rect.left;
                const width = rect.width;
                const right = left + width;
                const scale = x > s.dragX ? right - s.dragX : s.dragX - left;
                this.pageTurn(offsetX, scale, 200, Date.now() - s.startTime < 200 && Math.abs(offsetX) > width * 0.1);
              } else if (s.lastScroll) {
                shouldPreventDefault = true;
                const rollOut = (step: number) => {
                  if (!this.swipeState) {
                    const pos = el.scrollTop;
                    const t0 = Date.now();
                    el.scrollBy(0, step);
                    if (el.scrollTop !== pos) {
                      const t1 = Date.now();
                      step = Math.sign(step) * Math.floor(0.9 * Math.abs(step));
                      if (step) setTimeout(() => rollOut(step), Math.max(t1 - t0, 20));
                    }
                  }
                };
                const step = s.lastScroll;
                setTimeout(() => rollOut(step), 20);
              } else {
                this.snapBack();
              }
            }
            this.swipeState = null;
            // Safety net: if a flip had begun in this gesture but no branch above
            // took ownership of it (pageTurn was blocked or skipped — e.g. the
            // release landed at the exact start X, or the gesture ended in the
            // scroll branch after a flip had started), unwind it NOW. This is the
            // path that used to leave the page stranded mid-rotation and lifted
            // out of the pane, with its area dead to all further input.
            if (this.flipActive && !this.animatingTurn && !this.pendingReset) this.snapBack();
          }
          break;
        }
        case "move": {
          const s = this.swipeState;
          if (s) {
            const offsetX = x - s.dragX;
            const offsetY = y - s.dragY;
            if (offsetX === 0 && offsetY === 0) break;
            const direction = offsetX !== 0 ? offsetX / Math.abs(offsetX) : 0;
            const rect = el.getBoundingClientRect();
            const left = rect.left;
            const width = rect.width;
            const right = left + width;
            let isScroll = el.scrollHeight > el.clientHeight && s.direction === 0;
            if (pageFlipEnabled && isScroll && s.totalScroll < el.clientHeight / 10 && Math.abs(offsetX) > 0.2 * (right - left)) isScroll = false;
            if (isScroll) {
              shouldPreventDefault = true;
              el.style.transform = "";
              s.lastScroll = s.dragY - y;
              el.scrollBy(0, s.lastScroll);
              s.totalScroll += Math.abs(s.lastScroll);
              s.dragY = y;
            } else if (pageFlipEnabled && direction !== 0 && s.direction * direction >= 0) {
              shouldPreventDefault = true;
              el.style.border = "solid black 1px";
              this.beginFlip();
              s.direction = direction;
              const scale = direction > 0 ? right - s.dragX : s.dragX - left;
              this.setPagePhase(offsetX, scale);
            }
          }
          break;
        }
      }
    }
    if (shouldPreventDefault) e.preventDefault();
  }

  // ── the rotation itself ───────────────────────────────────────────────────────

  // The current page rotates (perspective lives on the container, so a plain
  // rotateY() makes it "come out" of the plane); the prev/next pages sit behind it
  // and the one in the drag direction is revealed as it rotates away.
  private setPagePhase(offset: number, scale: number): void {
    const page = this.cfg.currentPage();
    if (!page || offset === 0 || scale === 0) return;
    const direction = offset / Math.abs(offset);
    page.style.transformOrigin = (direction < 0 ? "left" : "right") + " center";
    const deg = (offset * 90) / scale;
    page.style.transform = this.liftedPage ? `perspective(500vw) rotateY(${deg}deg)` : `rotateY(${deg}deg)`;
    this.updateShadow(offset, scale, direction, deg);
    const hidden = Math.abs(deg) < 5;
    const prev = this.cfg.prevPage();
    const next = this.cfg.nextPage();
    if (prev) {
      prev.style.zIndex = offset >= 0 ? "-1" : "-2";
      this.cfg.setNeighbourVisible(prev, !(hidden || offset < 0));
    }
    if (next) {
      next.style.zIndex = offset >= 0 ? "-2" : "-1";
      this.cfg.setNeighbourVisible(next, !(hidden || offset >= 0));
    }
  }

  // ── cast shadow ───────────────────────────────────────────────────────────────

  /** Position the dedicated shadow element for the current turn phase. It's a soft
   *  grey gradient anchored at the page's lifted edge, sharing the page's pivot and
   *  rotateY so it tracks that edge as it swings. Reach (width) and opacity grow
   *  linearly with the turn — so it fades in from the start, not only at the end —
   *  while its height is set independently of its width. */
  private updateShadow(offset: number, scale: number, direction: number, deg: number): void {
    const container = this.cfg.container();
    const page = this.cfg.currentPage();
    if (!container || !page) return;

    const lift = Math.min(Math.abs(offset) / scale, 1);
    let el = this.shadowEl;
    if (!el) {
      el = document.createElement("div");
      el.className = "pp-flip-shadow";
      el.setAttribute("aria-hidden", "true");
      el.style.position = "absolute";
      el.style.pointerEvents = "none";
      el.style.zIndex = "-1"; // behind the page (z 0), over the revealed neighbour
      el.style.filter = "blur(4px)";
      this.shadowEl = el;
    }

    const w = page.clientWidth;
    const reach = Math.max(1, w * PageFlip.SHADOW_REACH * lift);
    const heightPct = PageFlip.SHADOW_HEIGHT * 100;
    const rgb = PageFlip.SHADOW_RGB;
    const a = PageFlip.SHADOW_ALPHA;
    // Solid grey out to (1 - fade), then a short fade to transparent — so the
    // shadow has a definite edge like the original solid box-shadow clone, rather
    // than fading across its whole width.
    const solidStop = (1 - PageFlip.SHADOW_EDGE_FADE) * 100;

    const lifted = this.liftedPage;
    if (lifted) {
      if (el.parentElement !== document.body) document.body.appendChild(el);
      const rect = lifted.rect;
      el.style.position = "fixed";
      el.style.zIndex = "99999";
      el.style.top = `${rect.top + (rect.height * (100 - heightPct)) / 200}px`;
      el.style.height = `${(rect.height * heightPct) / 100}px`;
      el.style.transform = `perspective(500vw) rotateY(${deg}deg)`;
      if (direction < 0) {
        el.style.left = `${rect.left + w}px`;
        el.style.right = "auto";
        el.style.transformOrigin = `${-w}px 50%`;
        el.style.background = `linear-gradient(to right, rgba(${rgb}, ${a}) ${solidStop}%, rgba(${rgb}, 0))`;
      } else {
        el.style.left = `${rect.left - reach}px`;
        el.style.right = "auto";
        el.style.transformOrigin = `${w + reach}px 50%`;
        el.style.background = `linear-gradient(to left, rgba(${rgb}, ${a}) ${solidStop}%, rgba(${rgb}, 0))`;
      }
    } else {
      if (el.parentElement !== container) container.appendChild(el);
      el.style.position = "absolute";
      el.style.zIndex = "-1"; // behind the page (z 0), over the revealed neighbour
      el.style.top = `${(100 - heightPct) / 2}%`;
      el.style.height = `${heightPct}%`;
      el.style.transform = `rotateY(${deg}deg)`;
      if (direction < 0) {
        // Spine on the left, lifted edge on the right → extend rightward, darkest at
        // the page edge. Pivot about the spine (the page's left edge = -w from here).
        el.style.left = "100%";
        el.style.right = "auto";
        el.style.transformOrigin = `${-w}px 50%`;
        el.style.background = `linear-gradient(to right, rgba(${rgb}, ${a}) ${solidStop}%, rgba(${rgb}, 0))`;
      } else {
        el.style.left = "auto";
        el.style.right = "100%";
        el.style.transformOrigin = `${w + reach}px 50%`;
        el.style.background = `linear-gradient(to left, rgba(${rgb}, ${a}) ${solidStop}%, rgba(${rgb}, 0))`;
      }
    }
    el.style.width = `${reach}px`;
    el.style.opacity = `${lift}`;
    el.style.display = "block";
  }

  private clearShadow(): void {
    if (this.shadowEl) this.shadowEl.style.display = "none";
  }

  private pageTurn(from: number, scale: number, time: number, forced?: boolean): void {
    if (this.animatingTurn) return;
    // A refused turn must still unwind whatever the drag already rotated/lifted —
    // returning silently here used to strand the page half-turned (and, when
    // lifted, re-parented under <body> where its area no longer received the
    // host's gesture events at all).
    if (this.cfg.isChordSelectorOpen()) {
      this.snapBack();
      return;
    }
    const page = this.cfg.currentPage();
    if (!page || from === 0) {
      this.snapBack();
      return;
    }

    const direction = from / Math.abs(from);
    // direction < 0 → forward to next; > 0 → back to previous. Only actually turn
    // when the neighbour exists (matches the original's hasDoc() guard).
    const canNavigate = this.cfg.hasNeighbour(direction < 0);

    this.animatingTurn = true;
    page.style.border = "solid black 1px";
    this.beginFlip();
    from = Math.abs(from);
    const turn = (forced || from > 0.7 * scale) && canNavigate;
    const total = turn ? scale - from : -from;
    const start = Date.now();

    // The loop runs under this generation; cancel()/dispose()/finishPending()
    // bump it, which stops the loop dead instead of letting it keep rotating a
    // page that has already been reset (or fire a stale onAdvance).
    const gen = ++this.gestureGen;
    const phase = (last: number) => {
      if (gen !== this.gestureGen) return;
      const now = Date.now();
      const elapsed = now - start;
      const fwd = Math.min(elapsed / time, 1);
      this.setPagePhase(direction * (from + total * fwd), scale);
      if (elapsed >= time) {
        if (turn) {
          // Leave the current page rotated edge-on (invisible) with the revealed
          // neighbour showing; finishPending() resets it once the host has loaded
          // the new current song. The timer is the safety net if no load arrives.
          this.pendingReset = true;
          if (this.pendingResetTimer !== null) clearTimeout(this.pendingResetTimer);
          this.pendingResetTimer = window.setTimeout(() => this.finishPending(), 600);
          this.cfg.onAdvance(direction < 0);
        } else {
          this.snapBack();
        }
      } else {
        setTimeout(() => phase(now), Math.max(now - last, 20));
      }
    };
    phase(start);
  }

  /** Called by the host once a turned-to song has loaded into the current page,
   *  resetting the rotated-away page on top of the revealed neighbour so the flip
   *  lands without a blank frame. */
  finishPending(): void {
    if (!this.pendingReset) return;
    this.gestureGen++; // a stray phase tick must not re-rotate the freshly reset page
    this.pendingReset = false;
    if (this.pendingResetTimer !== null) {
      clearTimeout(this.pendingResetTimer);
      this.pendingResetTimer = null;
    }
    this.snapBack();
  }

  private hideNeighbours(): void {
    const prev = this.cfg.prevPage();
    const next = this.cfg.nextPage();
    if (prev) {
      this.cfg.setNeighbourVisible(prev, false);
      prev.style.zIndex = "-1";
    }
    if (next) {
      this.cfg.setNeighbourVisible(next, false);
      next.style.zIndex = "-1";
    }
  }

  // ── overflow / stacking during a flip ─────────────────────────────────────────

  // While a flip runs the rotating page "comes out" of the plane and may overlap
  // the chrome above it. Make the clipping ancestors (up to, but excluding, the
  // host boundary) temporarily non-clipping and lift the stacking layer.
  private beginFlip(): void {
    const el = this.cfg.container();
    if (!el || this.flipActive) return;
    this.flipActive = true;
    this.cfg.onFlipActiveChange?.(true);
    // Suppress the rotating page's scrollbar for the duration of the turn: a tall,
    // scrollable song otherwise rotates a scrollbar gutter edge-on, which looks
    // broken. This is purely visual (the class only hides the scrollbar, it does
    // not change overflow) so scroll position is untouched and there's no reflow;
    // it covers the page *and* its descendants since the scroll host can be a
    // child (the desktop editor) rather than the page itself (the client view).
    const page = this.cfg.currentPage();
    if (page) {
      page.classList.add(PageFlip.HIDE_SCROLLBAR_CLASS, PageFlip.UNCLIP_PAGE_CLASS);
      this.scrollbarHidden = page;
      if (this.cfg.liftCurrentPageDuringFlip?.()) this.liftCurrentPage(page);
    }
    this.flipOverflowTargets = [];
    let node: HTMLElement | null = this.liftedPage ? el.parentElement : el;
    while (node && !this.cfg.isFlipBoundary(node)) {
      if (window.getComputedStyle(node).overflow !== "visible") {
        this.flipOverflowTargets.push({ el: node, overflow: node.style.overflow });
        node.style.overflow = "visible";
      }
      node = node.parentElement;
    }
    el.style.zIndex = "100";
    el.style.position = "relative";
  }

  private endFlip(): void {
    const el = this.cfg.container();
    if (!el || !this.flipActive) return;
    this.flipActive = false;
    this.cfg.onFlipActiveChange?.(false);
    this.clearShadow();
    if (this.scrollbarHidden) {
      this.scrollbarHidden.classList.remove(PageFlip.HIDE_SCROLLBAR_CLASS, PageFlip.UNCLIP_PAGE_CLASS);
      this.scrollbarHidden = null;
    }
    this.restoreLiftedPage();
    for (const { el: node, overflow } of this.flipOverflowTargets) node.style.overflow = overflow;
    this.flipOverflowTargets = [];
    el.style.zIndex = "";
    el.style.position = "";
  }

  private liftCurrentPage(page: HTMLElement): void {
    if (this.liftedPage || !page.parentNode) return;
    const rect = page.getBoundingClientRect();
    const computed = window.getComputedStyle(page);
    const wasDark = !!page.closest("#mainView.dark");
    this.liftedPage = {
      page,
      parent: page.parentNode,
      nextSibling: page.nextSibling,
      rect,
      style: {
        position: page.style.position,
        inset: page.style.inset,
        left: page.style.left,
        top: page.style.top,
        width: page.style.width,
        height: page.style.height,
        zIndex: page.style.zIndex,
        boxSizing: page.style.boxSizing,
        backgroundColor: page.style.backgroundColor,
        color: page.style.color,
      },
    };
    document.body.appendChild(page);
    page.style.position = "fixed";
    page.style.inset = "auto";
    page.style.left = `${rect.left}px`;
    page.style.top = `${rect.top}px`;
    page.style.width = `${rect.width}px`;
    page.style.height = `${rect.height}px`;
    page.style.zIndex = "100000";
    page.style.boxSizing = "border-box";
    page.style.backgroundColor = wasDark ? "#000" : computed.backgroundColor;
    page.style.color = wasDark ? "#e9e9e9" : computed.color;
    page.classList.toggle(PageFlip.LIFTED_DARK_CLASS, wasDark);
  }

  private restoreLiftedPage(): void {
    const lifted = this.liftedPage;
    if (!lifted) return;
    const { page, parent, nextSibling, style } = lifted;
    const before = nextSibling && nextSibling.parentNode === parent ? nextSibling : null;
    parent.insertBefore(page, before);
    page.style.position = style.position;
    page.style.inset = style.inset;
    page.style.left = style.left;
    page.style.top = style.top;
    page.style.width = style.width;
    page.style.height = style.height;
    page.style.zIndex = style.zIndex;
    page.style.boxSizing = style.boxSizing;
    page.style.backgroundColor = style.backgroundColor;
    page.style.color = style.color;
    page.classList.remove(PageFlip.LIFTED_DARK_CLASS);
    this.liftedPage = null;
  }
}
