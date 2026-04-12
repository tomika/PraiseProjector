import { Display } from "../common/pp-types";
import { cloneDisplay, compareDisplays, generatePlaylistId, getEmptyDisplay } from "../common/pp-utils";
import { AsyncJobQueue } from "../common/asyncQueue";

class DisplayChangeListener {
  private lastDisplay: Display;

  constructor(
    private readonly callback: (display: Display) => void,
    referenceDisplay?: Display,
    public waitsForCall = false
  ) {
    this.lastDisplay = referenceDisplay || getEmptyDisplay();
  }

  checkForChange(newDisplay: Display): void {
    if (!compareDisplays(this.lastDisplay, newDisplay)) {
      this.lastDisplay = cloneDisplay(newDisplay);
      this.call(newDisplay);
    }
  }

  call(display: Display): void {
    this.waitsForCall = false;
    this.callback(display);
  }
}

const displayChangeListeners: DisplayChangeListener[] = [];

const currentDisplay = getEmptyDisplay();

// Serialize async changeDisplay calls to prevent interleaving
const changeDisplayQueue = new AsyncJobQueue();

// DisplayUpdateRequest type is the same as Display but all fields optional
export type DisplayUpdateRequest = {
  [K in keyof Display]?: Display[K];
};

export function getCurrentDisplay(): Display {
  return { ...currentDisplay, playlist: currentDisplay.playlist?.slice() };
}

export function changeDisplay(display: Display): Promise<void> {
  return changeDisplayQueue.enqueue(() => doChangeDisplay(display));
}

async function doChangeDisplay(display: Display): Promise<void> {
  console.debug("[App] changeDisplay:", {
    songId: display.songId,
    transpose: display.transpose,
    from: display.from,
    to: display.to,
    playlistLength: display.playlist?.length ?? 0,
  });

  Object.assign(currentDisplay, display);

  currentDisplay.playlist_id = await generatePlaylistId(currentDisplay.playlist || []);

  // create a shallow copy of the display object to prevent mutation issues for listeners
  for (const listener of displayChangeListeners.slice()) {
    listener.checkForChange(currentDisplay);
  }
}

export function updateDisplay(diff: DisplayUpdateRequest): void;
export function updateDisplay<K extends keyof Display>(key: K, value: Display[K]): void;
export function updateDisplay<K extends keyof Display>(keyOrDiff: K | DisplayUpdateRequest, value?: Display[K]) {
  changeDisplay(
    typeof keyOrDiff === "object"
      ? { ...currentDisplay, ...(keyOrDiff as DisplayUpdateRequest) }
      : { ...currentDisplay, [keyOrDiff]: value instanceof Array ? value.slice() : value }
  );
}

export function registerDisplayChangeListener(callback: (display: Display) => void, referenceDisplay?: Display) {
  const listener = new DisplayChangeListener(callback, referenceDisplay);
  displayChangeListeners.push(listener);
  return () => {
    const index = displayChangeListeners.indexOf(listener);
    if (index !== -1) displayChangeListeners.splice(index, 1);
    if (listener.waitsForCall) listener.call(currentDisplay);
  };
}

export async function waitForDisplayChange(
  referenceDisplay?: Display,
  timeoutMs = 3600000,
  checker?: () => boolean,
  checkerIntervalMs = 1000
): Promise<Display> {
  return new Promise<Display>((resolve) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const listener = new DisplayChangeListener(
      (newDisplay) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        const index = displayChangeListeners.indexOf(listener);
        if (index !== -1) displayChangeListeners.splice(index, 1);
        resolve(newDisplay);
      },
      referenceDisplay,
      true
    );

    displayChangeListeners.push(listener);

    if (checker) {
      const endTime = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
      const intervalHandle = setInterval(() => {
        if (checker() || Date.now() >= endTime) {
          clearInterval(intervalHandle);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          listener.call(currentDisplay);
        }
      }, checkerIntervalMs);
    } else if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null;
        listener.call(currentDisplay);
      }, timeoutMs);
    }
  });
}

export function flushAllDisplayChangeListeners() {
  for (const listener of displayChangeListeners.slice()) {
    listener.call(currentDisplay);
  }
}
