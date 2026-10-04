/**
 * The smallest browser surface the renderer modules touch at runtime: a `window`
 * EventTarget with in-memory `localStorage`, viewport size and `matchMedia`. It
 * stands in for the environment only — production modules run unchanged.
 */
export interface FakeWindowOptions {
  width?: number;
  height?: number;
  prefersDark?: boolean;
  storage?: Record<string, string>;
  /** Make every localStorage write throw (quota / blocked storage). */
  failWrites?: boolean;
}

export class MemoryStorage {
  private readonly data = new Map<string, string>();
  failWrites = false;
  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.data.set(key, value);
  }
  get length(): number {
    return this.data.size;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.data.set(key, String(value));
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

export interface FakeWindow extends EventTarget {
  localStorage: MemoryStorage;
  innerWidth: number;
  innerHeight: number;
  matchMedia(query: string): { matches: boolean; addEventListener(): void; removeEventListener(): void };
  events: string[];
}

/** Installs `window`/`localStorage` globals; returns the window and a restore function. */
export function installFakeWindow(options: FakeWindowOptions = {}): { window: FakeWindow; restore: () => void } {
  const target = new EventTarget() as FakeWindow;
  const storage = new MemoryStorage(options.storage);
  storage.failWrites = !!options.failWrites;
  target.localStorage = storage;
  target.innerWidth = options.width ?? 1280;
  target.innerHeight = options.height ?? 860;
  target.events = [];
  target.matchMedia = (query: string) => ({
    matches: query.includes("prefers-color-scheme: dark") ? !!options.prefersDark : false,
    addEventListener() {},
    removeEventListener() {},
  });
  const dispatch = target.dispatchEvent.bind(target);
  target.dispatchEvent = (event: Event) => {
    target.events.push(event.type);
    return dispatch(event);
  };
  const globals = globalThis as Record<string, unknown>;
  const previous = { window: globals.window, localStorage: globals.localStorage };
  globals.window = target;
  globals.localStorage = storage;
  return {
    window: target,
    restore: () => {
      globals.window = previous.window;
      globals.localStorage = previous.localStorage;
    },
  };
}
