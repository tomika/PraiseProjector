const CACHE_VERSION = "v4";
const CACHE_NAME = "praiseprojector-" + CACHE_VERSION;

const assets = [
  "/app/main.html",
  "/app/praiseprojector.css",
  "/app/chordselector.css",
  "/app/chordpro.css",
  "/app/calendar.css",
  "/app/pp-api.js",
  "/app/manifest.json",
  "/app/images/netdisplay.png",
  "/app/images/about.svg",
  "/app/images/access-denied.svg",
  "/app/images/access-granted.svg",
  "/app/images/am.svg",
  "/app/images/approve.svg",
  "/app/images/autolight.svg",
  "/app/images/cancel.svg",
  "/app/images/capo.svg",
  "/app/images/clear.svg",
  "/app/images/clear-app.svg",
  "/app/images/close-up.svg",
  "/app/images/database.svg",
  "/app/images/day.svg",
  "/app/images/download.svg",
  "/app/images/drop.svg",
  "/app/images/edit-instructions.svg",
  "/app/images/enter.svg",
  "/app/images/erase.svg",
  "/app/images/exit.svg",
  "/app/images/fitpage.svg",
  "/app/images/found_head.svg",
  "/app/images/found_head_words.svg",
  "/app/images/found_lyrics.svg",
  "/app/images/found_lyrics_words.svg",
  "/app/images/found_meta.svg",
  "/app/images/found_meta_words.svg",
  "/app/images/found_title.svg",
  "/app/images/found_title_words.svg",
  "/app/images/fullscreen.svg",
  "/app/images/gear.svg",
  "/app/images/guitarchord.svg",
  "/app/images/hand.svg",
  "/app/images/home.svg",
  "/app/images/keep.svg",
  "/app/images/keys.svg",
  "/app/images/lamp.svg",
  "/app/images/leader.svg",
  "/app/images/left.svg",
  "/app/images/longlist.svg",
  "/app/images/magnifier.svg",
  "/app/images/menu.svg",
  "/app/images/nearby.svg",
  "/app/images/night.svg",
  "/app/images/nochordbox.svg",
  "/app/images/no-signal.svg",
  "/app/images/note-apply.svg",
  "/app/images/note-cancel.svg",
  "/app/images/note-create.svg",
  "/app/images/off.svg",
  "/app/images/offline.svg",
  "/app/images/ok.svg",
  "/app/images/online.svg",
  "/app/images/options.svg",
  "/app/images/overwrite.svg",
  "/app/images/pause.svg",
  "/app/images/pianochord.svg",
  "/app/images/play.svg",
  "/app/images/playlist.svg",
  "/app/images/play-online.svg",
  "/app/images/power.svg",
  "/app/images/pp.svg",
  "/app/images/reject.svg",
  "/app/images/report.svg",
  "/app/images/reset.svg",
  "/app/images/restore.svg",
  "/app/images/revert.svg",
  "/app/images/right.svg",
  "/app/images/save.svg",
  "/app/images/scan.svg",
  "/app/images/scrollpage.svg",
  "/app/images/share.svg",
  "/app/images/startup.svg",
  "/app/images/stop.svg",
  "/app/images/store.svg",
  "/app/images/tablet.svg",
  "/app/images/todo.svg",
  "/app/images/transpose.svg",
  "/app/images/trashcan.svg",
  "/app/images/upload.svg",
  "/app/images/user.svg",
  "/app/images/wand.svg",
  "/app/images/wifi.svg",
  "/app/images/www.svg",
  "/app/images/zoom.svg",
  "/app/soundfont/acoustic_grand_piano-mp3.js",
  "/app/soundfont/acoustic_grand_piano-ogg.js",
  "/app/soundfont/acoustic_guitar_nylon-mp3.js",
  "/app/soundfont/acoustic_guitar_nylon-ogg.js",
];

const assetSet = new Set(assets);

self.addEventListener("install", (event) => {
  console.log("[SW legacy] Installing " + CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(assets).catch((error) => {
        console.error("[SW legacy] Some assets failed to cache:", error);
      });
    }).catch((error) => {
      console.error("[SW legacy] Error opening cache:", error);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("[SW legacy] Activating " + CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names
          .filter((name) => name.startsWith("praiseprojector-") && name !== CACHE_NAME)
          .map((name) => {
            console.log("[SW legacy] Deleting old cache:", name);
            return caches.delete(name);
          })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Known precached asset — cache-first with network fallback
  if (assetSet.has(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cached) => {
          if (cached) {
            // Stale-while-revalidate: return cached, update in background
            fetch(event.request).then((response) => {
              if (response.ok) cache.put(event.request, response);
            }).catch(() => {});
            return cached;
          }
          // Not cached yet — fetch and cache
          return fetch(event.request).then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => {
            return new Response("Offline", { status: 503 });
          });
        });
      })
    );
    return;
  }

  // Non-asset request — network-first with graceful offline fallback
  event.respondWith(
    fetch(event.request).catch(() => {
      // If it's a navigation request, serve main.html from cache as fallback
      if (event.request.mode === "navigate") {
        return caches.match("/app/main.html").then((cached) => {
          return cached || new Response("Offline", { status: 503 });
        });
      }
      return new Response("Offline", { status: 503 });
    })
  );
});
