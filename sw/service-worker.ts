//There needs to be at least one export so that this isn't in global scope.
export type Version = number;

const version: Version = 0;

// NOTE: The default context is just Worker and we need to be the more specific ServiceWorker
declare let self: ServiceWorkerGlobalScope

/**
 * Core assets to cache on install
 */
const coreAssets: string[] = [];

/**
 * Cache name for versioning
 */
const cacheName = 'test-site-1';

if (typeof self !== 'undefined') {
	if (process.env.NODE_ENV === 'development') {
		console.debug({ version });
	}

	/**
	 * On install, cache core assets
	 */
	self.addEventListener('install', (event: ExtendableEvent): void => {
		// Cache core assets
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
		// Get the request
		const request = event.request;

		// Bug fix
		// https://stackoverflow.com/a/49719964
		if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

		// Get Accept header value
		const acceptHeader = request.headers.get('Accept') || '';

		// HTML files - Network-first strategy
		if (acceptHeader.includes('text/html')) {
			event.respondWith(
				fetch(request)
					.then((response: Response) => {
						// Create a copy of the response and save it to the cache
						const copy = response.clone();
						event.waitUntil(
							caches.open(cacheName).then((cache: Cache) => {
								return cache.put(request, copy);
							})
						);
						// Return the response
						return response;
					})
					.catch(async () => {
						// If there's no item in cache, respond with a fallback
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

		// CSS & JavaScript - Offline-first strategy
		if (acceptHeader.includes('text/css') || acceptHeader.includes('text/javascript')) {
			event.respondWith(
				caches.match(request).then((response) => {
					return response ||
						fetch(request).catch(() => {
							// Return a placeholder or empty response when offline
							if (acceptHeader.includes('text/css')) {
								return new Response('/* Offline stylesheet */', {
									headers: { 'Content-Type': 'text/css' }
								});
							}
							return new Response('/* Offline script */', {
								headers: { 'Content-Type': 'text/javascript' }
							});
						});
				})
			);
			return;
		}

		// Images - Offline-first with cache update
		if (acceptHeader.includes('image')) {
			event.respondWith(
				caches.match(request).then((response) => {
					return response ||
						fetch(request)
							.then((fetchResponse) => {
								// Save a copy of it in cache
								const copy = fetchResponse.clone();
								event.waitUntil(
									caches.open(cacheName).then((cache) => {
										return cache.put(request, copy);
									})
								);
								// Return the response
								return fetchResponse;
							})
							.catch(() => {
								// Return a placeholder image when offline
								// This could be an inline SVG or a default image
								return new Response('', {
									status: 503,
									statusText: 'Service Unavailable'
								});
							});
				})
			);
		}
	});
}
