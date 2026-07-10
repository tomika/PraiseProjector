const LOCKED_VIEWPORT = "width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no";

let installed = false;

function lockViewportZoom() {
  let viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!viewport) {
    viewport = document.createElement("meta");
    viewport.name = "viewport";
    document.head.appendChild(viewport);
  }
  viewport.content = LOCKED_VIEWPORT;
}

export function disableDefaultZoom() {
  if (installed) return;
  installed = true;

  lockViewportZoom();

  const prevent = (event: Event) => {
    event.preventDefault();
  };

  const preventMultiTouch = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault();
  };

  const preventPinchWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  };

  const touchOptions: AddEventListenerOptions = { capture: true, passive: false };
  const wheelOptions: AddEventListenerOptions = { capture: true, passive: false };

  document.addEventListener("touchmove", preventMultiTouch, touchOptions);
  document.addEventListener("gesturestart", prevent, touchOptions);
  document.addEventListener("gesturechange", prevent, touchOptions);
  document.addEventListener("gestureend", prevent, touchOptions);
  window.addEventListener("wheel", preventPinchWheel, wheelOptions);
}
