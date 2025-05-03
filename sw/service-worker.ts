//There needs to be at least one export so that this isn't in global scope.
export type Version = number;

const version: Version = 0;

//NOTE: The default context is just Worker and we need to be the more specific ServiceWorker.
declare let self: ServiceWorkerGlobalScope

/**
 * Core assets to cache on install
 */
const coreAssets: string[] = [
  '/offline.html'
];

/**
 * Cache name for versioning
 */
const cacheName = 'test-site-1';

/**
 * File extensions that should be cached.
 */
const CACHEABLE_EXTENSIONS = [
  'js', 'css', 'json', 'woff', 'woff2', 'ttf', 'eot',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico',
  'mp4', 'webm', 'mp3', 'wav'
];

/**
 * Checks if a URL has a hash pattern.
 */
const hasHashPattern = (url: string): boolean => {
  return /[-_.][a-zA-Z0-9]{5,}\.[a-zA-Z0-9]+$/i.test(new URL(url, self.location.origin).pathname);
};

/**
 * Checks if a URL should be cached based on extension and/or hash pattern.
 */
const shouldCache = (url: string): boolean => {
  try {
    const urlObj = new URL(url, self.location.origin);

    //Always cache assets with hash patterns.
    if (hasHashPattern(urlObj.toString())) {
      return true;
    }

    //Check exceptions list.
    const pathExceptions = ['/service-worker.js', '/offline.html', '/manifest.json'];
    if (pathExceptions.includes(urlObj.pathname)) {
      return true;
    }

    //Cache based on file extension.
    const fileExtension = urlObj.pathname.split('.').pop()?.toLowerCase();
    if (fileExtension && CACHEABLE_EXTENSIONS.includes(fileExtension)) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
};

if (typeof self !== 'undefined') {
  if (process.env.NODE_ENV === 'development') {
    console.debug({ version });
  }

  /**
   * On install, cache core assets
   */
  self.addEventListener('install', (event: ExtendableEvent): void => {
    //Cache core assets.
    event.waitUntil(
      caches.open(cacheName).then((cache: Cache) => {
        for (const asset of coreAssets) {
          cache.add(new Request(asset));
        }
        return cache;
      })
    );
  });

  /**
   * Listen for request events
   */
  self.addEventListener('fetch', (event: FetchEvent): void => {
    //Get the request.
    const request = event.request;

    //Bug fix.
    //https://stackoverflow.com/a/49719964.
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
      return;
    }

    //Skip non-GET requests and requests to other origins.
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
      return;
    }

    //Get Accept header value.
    const acceptHeader = request.headers.get('Accept') || '';

    //HTML files - Network-first strategy.
    if (acceptHeader.includes('text/html')) {
      event.respondWith(
        fetch(request)
          .then((response: Response) => {
            //Create a copy of the response and save it to the cache.
            const copy = response.clone();
            event.waitUntil(
              caches.open(cacheName).then((cache: Cache) => {
                return cache.put(request, copy);
              })
            );
            //Return the response.
            return response;
          })
          .catch(async () => {
            //If there's no item in cache, respond with a fallback.
            const response = await caches.match(request);
            return response || caches.match('/offline.html').then(fallbackResponse => {
              return fallbackResponse || new Response('Offline page not found', {
                status: 503,
                statusText: 'Service Unavailable',
                headers: new Headers({
                  'Content-Type': 'text/plain'
                })
              });
            });
          })
      );
      return;
    }

    //For assets that should be cached.
    if (shouldCache(request.url)) {
      event.respondWith(
        caches.match(request).then((response) => {
          //If asset is in cache already, return it immediately.
          if (response) {
            return response;
          }

          //Otherwise fetch from network and cache.
          return fetch(request)
            .then((fetchResponse) => {
              //Save a copy in cache.
              const copy = fetchResponse.clone();
              event.waitUntil(
                caches.open(cacheName).then((cache) => {
                  return cache.put(request, copy);
                })
              );
              //Return the response.
              return fetchResponse;
            })
            .catch(() => {
              //Return appropriate fallback based on content type.
              if (acceptHeader.includes('text/css')) {
                return new Response('/* Offline stylesheet */', {
                  headers: { 'Content-Type': 'text/css' }
                });
              } else if (acceptHeader.includes('text/javascript')) {
                return new Response('/* Offline script */', {
                  headers: { 'Content-Type': 'text/javascript' }
                });
              } else if (acceptHeader.includes('image')) {
                //Return empty response for images.
                return new Response('', {
                  status: 503,
                  statusText: 'Service Unavailable'
                });
              } else if (acceptHeader.includes('audio') || acceptHeader.includes('video')) {
                //Return empty response for media.
                return new Response('', {
                  status: 503,
                  statusText: 'Service Unavailable'
                });
              } else {
                //Default response for other assets.
                return new Response('Resource unavailable offline', {
                  status: 503,
                  statusText: 'Service Unavailable'
                });
              }
            });
        })
      );
      return;
    }

    //For all other requests, try network first, don't cache.
    //This is a fallback for any unhandled request types.
    event.respondWith(
      fetch(request)
        .catch(() => {
          return new Response('Network request failed', {
            status: 503,
            statusText: 'Service Unavailable'
          });
        })
    );
  });

  /**
   * On activate, clean up old caches
   */
  self.addEventListener('activate', (event: ExtendableEvent): void => {
    //Clean up old cache versions.
    event.waitUntil(
      caches.keys().then(keys => {
        return Promise.all(
          keys
            .filter(key => key !== cacheName)
            .map(key => caches.delete(key))
        );
      })
    );
  });
}
