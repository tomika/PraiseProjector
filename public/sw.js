// PraiseProjector Service Worker for PWA support
// Version is updated when app is rebuilt to bust cache
const CACHE_VERSION = 'v2';
const STATIC_CACHE = `praiseprojector-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `praiseprojector-dynamic-${CACHE_VERSION}`;

// Core assets that must be cached for offline use.
// client-view.html is the standalone follower client (installable PWA start_url);
// it is a separate Vite entry from index.html with its own hashed bundle, so it
// must be precached and asset-discovered independently of the main app.
const CORE_ASSETS = [
  '/webapp/',
  '/webapp/index.html',
  '/webapp/client-view.html',
  '/webapp/projector.html',
  '/webapp/assets/wifi.png',
  '/webapp/manifest.json',
  '/webapp/manifest-client.json'
];

// Build-emitted manifest of every file under /webapp (hashed bundles + lifted
// legacy assets: icons, soundfonts, chordpro CSS). Precached so the installed
// client PWA — including the follower view and offline MIDI — works fully offline.
const PRECACHE_MANIFEST = '/webapp/precache.json';

// HTML entry points whose JS/CSS bundles should be discovered and precached.
// This is a FALLBACK for when the precache manifest can't be fetched — it only
// finds bundles directly referenced in the entry HTML (entry + modulepreloaded
// vendors), not the lazily-imported dialog chunks. index.html = full view,
// client-view.html = follower client view; both must be covered.
const ENTRY_PAGES = ['/webapp/index.html', '/webapp/client-view.html'];

// Fetch a URL, retrying a few times before giving up. Mobile networks and the
// Android host webserver proxy occasionally drop the very first request; without
// a retry a single miss on the precache manifest used to silently skip the whole
// precache and leave the app almost entirely uncached.
async function fetchWithRetry(url, options, attempts) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
    } catch (e) {
      // network error — fall through to backoff and retry
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  return null;
}

// Add a list of URLs to the cache in parallel batches. Parallelism keeps install
// fast enough to finish before some Android WebViews tear the worker down mid-install
// (the previous sequential await of 200+ files was slow enough to be interrupted,
// leaving a partial cache). allSettled means one 404 never aborts the rest.
async function cacheAllSettled(cache, urls) {
  const BATCH_SIZE = 24;
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const slice = urls.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(slice.map((url) => cache.add(url)));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        ok++;
      } else {
        failed++;
        console.warn('[SW] Failed to cache:', slice[index]);
      }
    });
  }
  return { ok, failed };
}

// Install event - cache core assets and precache the full /webapp tree
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker ' + CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      console.log('[SW] Caching core assets');
      // Cache core assets (the shells both views need to boot offline).
      await cache.addAll(CORE_ASSETS);

      // Discover the main JS/CSS bundles by fetching each entry page and parsing it.
      // Used both as a warm-up and as the fallback set if the precache manifest is
      // unreachable, so the full view and the client view can at least cold-start offline.
      const discovered = new Set();
      for (const page of ENTRY_PAGES) {
        try {
          const response = await fetch(page);
          const html = await response.text();
          const assetMatches = html.matchAll(/(?:src|href)="([^"]*\.(?:js|css))"/g);
          for (const match of assetMatches) {
            const url = match[1];
            if (url.startsWith('/webapp/') || url.startsWith('./') || url.startsWith('assets/')) {
              discovered.add(url.startsWith('/') ? url : '/webapp/' + url.replace('./', ''));
            }
          }
        } catch (e) {
          console.warn('[SW] Could not discover assets from', page, ':', e);
        }
      }

      // Precache the full /webapp tree (build-emitted, authoritative — includes the
      // hashed bundles for BOTH the full view and the client view, every lazily-loaded
      // dialog chunk, images, soundfonts and chordpro CSS). Retry the manifest fetch so
      // a transient failure does not silently skip everything.
      let precachePaths = [];
      const manifestResp = await fetchWithRetry(PRECACHE_MANIFEST, { cache: 'no-store' }, 3);
      if (manifestResp) {
        try {
          const paths = await manifestResp.json();
          if (Array.isArray(paths)) {
            precachePaths = paths.filter((p) => typeof p === 'string');
          }
        } catch (e) {
          console.warn('[SW] Could not parse precache manifest:', e);
        }
      } else {
        console.error('[SW] Precache manifest unavailable after retries — caching discovered bundles only');
      }

      // Cache the union of the precache manifest and the discovered bundles, in parallel.
      const allAssets = Array.from(new Set([...precachePaths, ...discovered]));
      console.log('[SW] Precaching', allAssets.length, 'assets');
      const { ok, failed } = await cacheAllSettled(cache, allAssets);
      console.log('[SW] Precached', ok, 'assets (' + failed + ' failed)');
    })
  );
  // Activate immediately
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker ' + CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('praiseprojector-') &&
                          name !== STATIC_CACHE &&
                          name !== DYNAMIC_CACHE)
          .map((name) => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    })
  );
  // Take control of all pages immediately
  self.clients.claim();
});

// Helper: is this an API request?
function isApiRequest(url) {
  return new URL(url).pathname.startsWith('/praiseprojector/');
}

function isProjectorNavigation(url) {
  return new URL(url).pathname === '/webapp/projector.html';
}

function isClientViewNavigation(url) {
  return new URL(url).pathname === '/webapp/client-view.html';
}

// Helper: is this a static asset?
function isStaticAsset(url) {
  return url.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|json)(\?.*)?$/i);
}

// Fetch event - cache-first for static assets, network-first for HTML
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip API calls - always go to network (no caching)
  if (isApiRequest(event.request.url)) {
    return;
  }

  // Skip cross-origin requests except for fonts
  if (url.origin !== self.location.origin && !event.request.url.includes('fonts')) {
    return;
  }

  // For navigation requests (HTML pages) - network first, cache fallback.
  // cache:'no-store' bypasses the browser HTTP cache so a stale HTTP-cached
  // shell can never shadow a freshly deployed one. This is the ONLINE path; when
  // offline the fetch rejects and we fall through to caches.match below, so this
  // does not weaken offline behaviour.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((response) => {
          // Cache the response
          const responseClone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(() => {
          // Offline - serve from cache
          return caches.match(event.request).then((cached) => {
            if (cached) {
              return cached;
            }
            // Fall back to the matching entry page so an offline cold launch of the
            // installed client PWA does not load the full desktop app (index.html).
            const fallbackPath = isProjectorNavigation(event.request.url)
              ? '/webapp/projector.html'
              : isClientViewNavigation(event.request.url)
                ? '/webapp/client-view.html'
                : '/webapp/index.html';
            return caches.match(fallbackPath);
          });
        })
    );
    return;
  }

  // For static assets - cache first, network fallback (stale-while-revalidate)
  if (isStaticAsset(event.request.url)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) {
          // Return cached, but also update cache in background
          fetch(event.request).then((response) => {
            if (response.ok) {
              caches.open(STATIC_CACHE).then((cache) => {
                cache.put(event.request, response);
              });
            }
          }).catch(() => {});
          return cached;
        }

        // Not in cache, fetch and cache
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        }).catch(() => {
          // Return a 1x1 transparent SVG placeholder for missing images
          if (event.request.url.match(/\.(png|jpg|jpeg|gif|svg)$/i)) {
            return new Response(
              '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
              { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }
            );
          }
          return new Response('Offline', { status: 503 });
        });
      })
    );
    return;
  }

  // Default: network first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          return cached || new Response('Offline', { status: 503 });
        });
      })
  );
});

// Handle messages from the app
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }

  // Allow app to request cache refresh
  if (event.data === 'clearCache') {
    caches.keys().then((names) => {
      names.forEach((name) => caches.delete(name));
    });
  }
});
