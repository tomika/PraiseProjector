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
const ENTRY_PAGES = ['/webapp/index.html', '/webapp/client-view.html'];

// Install event - cache core assets and discover JS/CSS bundles
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker ' + CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      console.log('[SW] Caching core assets');
      // Cache core assets
      await cache.addAll(CORE_ASSETS);

      // Also try to cache the main JS/CSS bundles by fetching each entry page and parsing.
      for (const page of ENTRY_PAGES) {
        try {
          const response = await fetch(page);
          const html = await response.text();

          // Extract JS and CSS file references
          const assetMatches = html.matchAll(/(?:src|href)="([^"]*\.(?:js|css))"/g);
          const assets = [];
          for (const match of assetMatches) {
            const url = match[1];
            if (url.startsWith('/webapp/') || url.startsWith('./') || url.startsWith('assets/')) {
              const fullUrl = url.startsWith('/') ? url : '/webapp/' + url.replace('./', '');
              assets.push(fullUrl);
            }
          }

          console.log('[SW] Caching', assets.length, 'discovered assets from', page);
          for (const asset of assets) {
            try {
              await cache.add(asset);
            } catch (e) {
              console.warn('[SW] Failed to cache:', asset);
            }
          }
        } catch (e) {
          console.warn('[SW] Could not discover assets from', page, ':', e);
        }
      }

      // Precache the full /webapp tree (build-emitted) so the client PWA works
      // fully offline. Added individually (not addAll) so one miss never aborts
      // the whole install.
      try {
        const manifestResp = await fetch(PRECACHE_MANIFEST, { cache: 'no-store' });
        if (manifestResp.ok) {
          const paths = await manifestResp.json();
          if (Array.isArray(paths)) {
            console.log('[SW] Precaching', paths.length, 'assets from', PRECACHE_MANIFEST);
            for (const assetPath of paths) {
              if (typeof assetPath !== 'string') continue;
              try {
                await cache.add(assetPath);
              } catch (e) {
                console.warn('[SW] Failed to precache:', assetPath);
              }
            }
          }
        } else {
          console.warn('[SW] Precache manifest unavailable:', manifestResp.status);
        }
      } catch (e) {
        console.warn('[SW] Could not load precache manifest:', e);
      }
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
