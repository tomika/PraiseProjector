import type { Display } from "../../../../common/pp-types";

type DisplayListener = (display: Display) => void;

/** A followed snapshot stays authoritative while the host updates its own UI. */
export class DirectDisplaySource {
  private followed: Display | null = null;
  private readonly listeners = new Set<DisplayListener>();
  private readonly getHostDisplay: () => Display;
  private readonly subscribeHostDisplay: (listener: DisplayListener) => () => void;

  constructor(getHostDisplay: () => Display, subscribeHostDisplay: (listener: DisplayListener) => () => void) {
    this.getHostDisplay = getHostDisplay;
    this.subscribeHostDisplay = subscribeHostDisplay;
  }

  getCurrent(): Display {
    return this.followed ?? this.getHostDisplay();
  }

  follow(display: Display): void {
    this.followed = display;
    for (const listener of this.listeners) listener(display);
  }

  stopFollowing(): void {
    this.followed = null;
  }

  subscribe(listener: DisplayListener): () => void {
    this.listeners.add(listener);
    const unsubscribe = this.subscribeHostDisplay((display) => {
      if (!this.followed) listener(display);
    });
    return () => {
      this.listeners.delete(listener);
      unsubscribe();
    };
  }
}
