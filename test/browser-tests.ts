import { type Browser, type Page, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Logger } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';

class TestLogger implements Logger {
  hasWarned = false;
  private warnedMessages = new Set<string>();

  info(msg: string, _options?: { timestamp?: boolean }) {
    process.stdout.write(`[INFO] ${msg}\n`);
  }

  warn(msg: string) {
    this.hasWarned = true;
    process.stderr.write(`[WARN] ${msg}\n`);
  }

  warnOnce(msg: string) {
    if (!this.warnedMessages.has(msg)) {
      this.warn(msg);
      this.warnedMessages.add(msg);
    }
  }

  error(msg: string, options?: { error?: Error }) {
    process.stderr.write(`[ERROR] ${msg}\n`);
    if (options?.error) {
      process.stderr.write(`${options.error.stack || options.error.message}\n`);
    }
  }

  clearScreen(msg: string) {
    if (msg) {
      this.info(msg);
    }
  }

  hasErrorLogged(_error: Error): boolean {
    return false;
  }
}


describe('Asset Hashing Tests', () => {
  let baseUrl = '';
  let browser: Browser | undefined;
  let page: Page | undefined;
  const logger = new TestLogger();

  beforeAll(async () => {
    try {
      const port = await fs.readFile(path.join(process.cwd(), '.temp', 'vite-port'), 'utf-8');
      baseUrl = `http://localhost:${port}`;

      logger.info(`Starting tests with base URL: ${baseUrl}.`);
      browser = await chromium.launch();

      logger.info('Browser launched successfully.');
    } catch (error) {
      logger.error('Failed to set up test environment.', {
        error: error instanceof Error ? error : new Error(String(error))
      });
      throw error;
    }
  });

  beforeEach(async () => {
    if (browser) {
      page = await browser.newPage();
      logger.info('New page created for test.');
    }
  });

  afterEach(async () => {
    if (page) {
      await page.close();
      logger.info('Test page closed.');
    }
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
      logger.info('Browser closed.');
    }
  });


  test('manifest.json has hash in filename and hashed paths inside', async () => {
    if (!page) {
      throw new Error('Page is not initialized.');
    }

    await page.goto(baseUrl);
    const manifestHref = await page.evaluate(() => {
      const manifestLink = document.querySelector('link[rel="manifest"]');
      return manifestLink ? manifestLink.getAttribute('href') : null;
    });

    expect(manifestHref).not.toBeNull();
    expect(manifestHref).toMatch(/manifest-[a-zA-Z0-9_]+\.json$/);

    const manifestUrl = new URL(manifestHref!, baseUrl).toString();
    logger.info(`Fetching manifest from: ${manifestUrl}`);

    const manifestResponse = await page.goto(manifestUrl);
    expect(manifestResponse?.ok()).toBe(true);

    const manifestJson = await page.evaluate(() => {
      const preElement = document.querySelector('pre');
      return preElement ? preElement.textContent : null;
    });

    expect(manifestJson).not.toBeNull();

    const manifest = JSON.parse(manifestJson!);
    if (manifest.icons && Array.isArray(manifest.icons)) {
      expect(manifest.icons.length).toBeGreaterThan(0);

      for (const icon of manifest.icons) {
        expect(icon).toHaveProperty('src');
        expect(icon.src).toMatch(/-[a-zA-Z0-9_]+\.[a-z]+$/);
      }
    }

    const checkForHashedAssets = (obj: unknown): void => {
      if (!obj || typeof obj !== 'object') {
        return;
      }

      if (Array.isArray(obj)) {
        obj.forEach(item => checkForHashedAssets(item));
        return;
      }

      Object.entries(obj as { [key: string]: unknown }).forEach(([key, value]) => {
        if (key !== 'icons' && typeof value === 'string' &&
          (value.includes('/assets/') || value.startsWith('/assets/'))) {
          expect(value).toMatch(/-[a-zA-Z0-9_]+\.[a-z]+$/);
        } else if (Array.isArray(value)) {
          value.forEach(item => checkForHashedAssets(item));
        } else if (typeof value === 'object' && value !== null) {
          checkForHashedAssets(value);
        }
      });
    };

    checkForHashedAssets(manifest);
  });


  test('JSON-LD scripts contain properly hashed asset paths', async () => {
		if (!page) {
			throw new Error('Page is not initialized');
		}

		await page.goto(baseUrl);

		const jsonLdScripts = await page.evaluate(() => {
			const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
			return scripts.map(script => script.textContent);
		});

		if (jsonLdScripts.length === 0) {
			return;
		}

		for (const script of jsonLdScripts) {
			if (script) {

				const jsonData = JSON.parse(script);

				const checkImageUrls = (obj: unknown): void => {
					if (!obj || typeof obj !== 'object') {
						return;
					}

					if (Array.isArray(obj)) {
						obj.forEach(item => checkImageUrls(item));
						return;
					}

					Object.entries(obj as { [key: string]: unknown }).forEach(([key, value]) => {
						if (typeof value === 'string' &&
							(key === 'image' || key === 'logo' || key.includes('Image')) &&
							(value.includes('/assets/') || value.startsWith('/assets/'))) {
							expect(value).toMatch(/-[a-zA-Z0-9_]+\.[a-z]+$/);
						} else if (Array.isArray(value)) {
							value.forEach(item => checkImageUrls(item));
						} else if (typeof value === 'object' && value !== null) {
							checkImageUrls(value);
						}
					});
				};

				checkImageUrls(jsonData);
			}
		}
	});


	test('Check all resources: broken links, proper cache busting, and service worker', async () => {
		if (!page) {
			throw new Error('Page is not initialized');
		}

		//First ensure a valid page, site root.
		await page.goto(baseUrl);

		const currentBaseUrl = new URL(page.url()).origin;
		const visitedUrls = new Set<string>();
		const brokenResources = new Map<string, {
			type: 'link' | 'image' | 'script' | 'stylesheet' | 'other',
			status: number | string,
			sources: string[]
		}>();

		//Track resources that should be hashed but aren't.
		const nonHashedResources = new Map<string, {
			type: 'image' | 'script' | 'stylesheet' | 'other',
			sources: string[]
		}>();

		//List of files that should NOT be hashed (exceptions).
		const hashExceptions = [
			'/service-worker.js',
			'/favicon.ico',
			'/robots.txt',
			'/sitemap.xml'
		];

		//Function to check if a URL should have a hash.
		const shouldHaveHash = (url: string): boolean => {
			const urlPath = new URL(url).pathname;

			//Check exceptions list.
			if (hashExceptions.some(exception => urlPath === exception)) {
				return false;
			}

			//Check file extensions that should have hashes.
			return /\.(js|css|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|eot)$/i.test(urlPath);
		};

		//Function to check if a URL has a hash pattern.
		const hasHashPattern = (url: string): boolean => {
			const urlPath = new URL(url).pathname;
			//Look for common hash patterns like -[hash].[ext] or .[hash].[ext].
			return /[-_.][a-zA-Z0-9]{5,}\.[\w]+$/i.test(urlPath);
		};

		const pagesToVisit = [currentBaseUrl];
		const maxPagesToVisit = 50;

		try {
			while (pagesToVisit.length > 0 && visitedUrls.size < maxPagesToVisit) {
				const currentUrl = pagesToVisit.shift();
				if (!currentUrl || visitedUrls.has(currentUrl) || !currentUrl.startsWith('http')) {
					continue;
				}

				logger.info(`Checking resources on: ${currentUrl}`);
				visitedUrls.add(currentUrl);

				try {
					await page.goto(currentUrl, { waitUntil: 'networkidle' });

					//Check for service worker.
					if (visitedUrls.size === 1) {
						const swUrl = new URL('/service-worker.js', currentBaseUrl).toString();
						const swResponse = await page.evaluate(async (url) => {
							try {
								const response = await fetch(url, { method: 'HEAD' });
								return {
									ok: response.ok,
									status: response.status
								};
							} catch (error) {
								return {
									ok: false,
									status: `Error: ${error instanceof Error ? error.message : String(error)}`
								};
							}
						}, swUrl);

						if (!swResponse.ok) {
							brokenResources.set(swUrl, {
								type: 'script',
								status: swResponse.status,
								sources: ['service-worker check']
							});
							logger.warn(`Service worker not found at root: ${swUrl} (${swResponse.status})`);
						} else {
							logger.info(`✓ Service worker found at root: ${swUrl}`);
						}
					}

					//Find all links on the page.
					const links = await page.evaluate(() => {
						return Array.from(document.querySelectorAll('a[href]'))
							.map(a => {
								return {
									href: a.getAttribute('href'),
									text: a.textContent?.trim() || '[No text]'
								};
							})
							.filter(link => link.href && !link.href.startsWith('mailto:') && !link.href.startsWith('tel:'));
					});

					//Find all images.
					const images = await page.evaluate(() => {
						return [
							...Array.from(document.querySelectorAll('img'))
								.map(img => ({ src: img.getAttribute('src'), type: 'regular' })),
							...Array.from(document.querySelectorAll('picture source[srcset]'))
								.map(source => ({ src: source.getAttribute('srcset'), type: 'srcset' }))
						]
						.filter(item => item.src && item.src.trim() !== '');
					});

					//Find all scripts, stylesheets, and other resources.
					const otherResources = await page.evaluate(() => {
						return {
							scripts: Array.from(document.querySelectorAll('script[src]'))
								.map(script => ({ src: script.getAttribute('src'), type: 'script' }))
								.filter(item => item.src && item.src.trim() !== ''),

							stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
								.map(link => ({ src: link.getAttribute('href'), type: 'stylesheet' }))
								.filter(item => item.src && item.src.trim() !== ''),

							other: [
								...Array.from(document.querySelectorAll('link[rel="preload"]'))
									.map(link => ({ src: link.getAttribute('href'), type: 'preload' })),
								...Array.from(document.querySelectorAll('link[rel="prefetch"]'))
									.map(link => ({ src: link.getAttribute('href'), type: 'prefetch' })),
								...Array.from(document.querySelectorAll('link[rel="icon"]'))
									.map(link => ({ src: link.getAttribute('href'), type: 'icon' }))
							].filter(item => item.src && item.src.trim() !== '')
						};
					});

					//Process links and add to crawl list.
					for (const link of links) {
						try {
							if (!link.href) {
								continue;
							}

							//Handle relative URLs.
							let fullUrl;
							try {
								fullUrl = new URL(link.href, currentUrl).toString();
							} catch (e) {
								logger.warn(`Invalid URL: ${link.href} on page ${currentUrl}`);
								continue;
							}

							const urlObj = new URL(fullUrl);

							//Skip external links and anchor links on the same page.
							if (urlObj.origin !== new URL(currentBaseUrl).origin) {
								continue;
							}
							if (urlObj.hash && urlObj.origin + urlObj.pathname === new URL(currentUrl).origin + new URL(currentUrl).pathname) {
								continue;
							}

							//Create a clean URL without hash for checking.
							const cleanUrl = urlObj.origin + urlObj.pathname + urlObj.search;

							//Check the link status using fetch in page context.
							const linkStatus = await page.evaluate(async (url) => {
								try {
									const response = await fetch(url, { method: 'HEAD' });
									return {
										ok: response.ok,
										status: response.status
									};
								} catch (error) {
									return {
										ok: false,
										status: `Error: ${error instanceof Error ? error.message : String(error)}`
									};
								}
							}, cleanUrl);

							if (!linkStatus.ok) {
								if (brokenResources.has(cleanUrl)) {
									brokenResources.get(cleanUrl)!.sources.push(currentUrl);
								} else {
									brokenResources.set(cleanUrl, {
										type: 'link',
										status: linkStatus.status,
										sources: [currentUrl]
									});
								}
								logger.warn(`Broken link found: ${cleanUrl} (${linkStatus.status}) - linked from ${currentUrl}`);
							} else if (!visitedUrls.has(cleanUrl) && !pagesToVisit.includes(cleanUrl)) {
								//Add to the pages to visit for further crawling (only for HTML pages).
								const contentType = await page.evaluate(async (url) => {
									try {
										const response = await fetch(url, { method: 'HEAD' });
										return response.headers.get('content-type');
									} catch {
										return null;
									}
								}, cleanUrl);

								if (contentType && contentType.includes('text/html')) {
									pagesToVisit.push(cleanUrl);
								}
							}
						} catch (error) {
							logger.warn(`Error processing link ${link.href}: ${error}`);
						}
					}

					//Process images.
					for (const image of images) {
						try {
							if (!image.src) {
								continue;
							}

							let imageSources = [image.src];
							//Handle srcset format (url size, url size, etc.).
							if (image.type === 'srcset' && image.src.includes(',')) {
								imageSources = image.src.split(',')
									.map(part => part.trim().split(/\s+/)[0]);
							}

							for (const imgSrc of imageSources) {
								//Handle relative URLs.
								let fullUrl;
								try {
									fullUrl = new URL(imgSrc, currentUrl).toString();
									if (!fullUrl.startsWith('http')) {
										continue;
									}
								} catch (e) {
									logger.warn(`Invalid image URL: ${imgSrc} on page ${currentUrl}`);
									continue;
								}

								//Skip external images.
								if (new URL(fullUrl).origin !== new URL(currentBaseUrl).origin) {
									continue;
								}

								//Check for hash in filename if needed.
								if (shouldHaveHash(fullUrl) && !hasHashPattern(fullUrl)) {
									if (nonHashedResources.has(fullUrl)) {
										nonHashedResources.get(fullUrl)!.sources.push(currentUrl);
									} else {
										nonHashedResources.set(fullUrl, {
											type: 'image',
											sources: [currentUrl]
										});
									}
									logger.warn(`Image without hash found: ${fullUrl} - on page ${currentUrl}`);
								}

								//Check the image.
								const imgStatus = await page.evaluate(async (url) => {
									try {
										const response = await fetch(url, { method: 'HEAD' });
										return {
											ok: response.ok,
											status: response.status
										};
									} catch (error) {
										return {
											ok: false,
											status: `Error: ${error instanceof Error ? error.message : String(error)}`
										};
									}
								}, fullUrl);

								if (!imgStatus.ok) {
									if (brokenResources.has(fullUrl)) {
										brokenResources.get(fullUrl)!.sources.push(currentUrl);
									} else {
										brokenResources.set(fullUrl, {
											type: 'image',
											status: imgStatus.status,
											sources: [currentUrl]
										});
									}
									logger.warn(`Broken image found: ${fullUrl} (${imgStatus.status}) - on page ${currentUrl}`);
								}
							}
						} catch (error) {
							logger.warn(`Error processing image ${image.src}: ${error}`);
						}
					}

					//Process scripts, stylesheets and other resources.
					const allOtherResources = [
						...otherResources.scripts,
						...otherResources.stylesheets,
						...otherResources.other
					];

					for (const resource of allOtherResources) {
						try {
							if (!resource.src) {
								continue;
							}

							//Handle relative URLs.
							let fullUrl;
							try {
								fullUrl = new URL(resource.src, currentUrl).toString();
								if (!fullUrl.startsWith('http')) {
									continue;
								}
							} catch (e) {
								logger.warn(`Invalid resource URL: ${resource.src} on page ${currentUrl}`);
								continue;
							}

							//Skip external resources.
							if (new URL(fullUrl).origin !== new URL(currentBaseUrl).origin) {
								continue;
							}

							//Check for hash in filename if needed.
							if (shouldHaveHash(fullUrl) && !hasHashPattern(fullUrl)) {
								if (nonHashedResources.has(fullUrl)) {
									nonHashedResources.get(fullUrl)!.sources.push(currentUrl);
								} else {
									nonHashedResources.set(fullUrl, {
										type: resource.type === 'stylesheet' ? 'stylesheet' : 'script',
										sources: [currentUrl]
									});
								}
								logger.warn(`Resource without hash found: ${fullUrl} - on page ${currentUrl}`);
							}

							//Check the resource.
							const resStatus = await page.evaluate(async (url) => {
								try {
									const response = await fetch(url, { method: 'HEAD' });
									return {
										ok: response.ok,
										status: response.status
									};
								} catch (error) {
									return {
										ok: false,
										status: `Error: ${error instanceof Error ? error.message : String(error)}`
									};
								}
							}, fullUrl);

							if (!resStatus.ok) {
								if (brokenResources.has(fullUrl)) {
									brokenResources.get(fullUrl)!.sources.push(currentUrl);
								} else {
									brokenResources.set(fullUrl, {
										type: resource.type === 'stylesheet' ? 'stylesheet' : 'script',
										status: resStatus.status,
										sources: [currentUrl]
									});
								}
								logger.warn(`Broken resource found: ${fullUrl} (${resStatus.status}) - on page ${currentUrl}`);
							}
						} catch (error) {
							logger.warn(`Error processing resource ${resource.src}: ${error}`);
						}
					}

				} catch (error) {
					logger.error(`Failed to check resources on page ${currentUrl}`, {
						error: error instanceof Error ? error : new Error(String(error))
					});
				}
			}
		} catch (error) {
			logger.error('Test error', { error: error instanceof Error ? error : new Error(String(error)) });
		}

		//Report broken resources by type.
		if (brokenResources.size > 0) {
			const brokenResourcesList = Array.from(brokenResources.entries()).map(([url, details]) => {
				return {
					url,
					type: details.type,
					status: details.status,
					sources: details.sources.join(', ')
				};
			});

			console.table(brokenResourcesList);

			const brokenByType = {
				links: brokenResourcesList.filter(r => r.type === 'link').length,
				images: brokenResourcesList.filter(r => r.type === 'image').length,
				scripts: brokenResourcesList.filter(r => r.type === 'script').length,
				stylesheets: brokenResourcesList.filter(r => r.type === 'stylesheet').length,
				other: brokenResourcesList.filter(r => r.type === 'other').length
			};

			logger.error(`Resource check failed: ${brokenResources.size} broken resources found`, {
				error: new Error(`Found ${brokenResources.size} broken resources: ${JSON.stringify(brokenByType)}`)
			});
		} else {
			logger.info(`✓ All resources checked successfully across ${visitedUrls.size} pages`);
		}

		//Report non-hashed resources.
		if (nonHashedResources.size > 0) {
			const nonHashedList = Array.from(nonHashedResources.entries()).map(([url, details]) => {
				return {
					url,
					type: details.type,
					sources: details.sources.join(', ')
				};
			});

			console.table(nonHashedList);

			const nonHashedByType = {
				images: nonHashedList.filter(r => r.type === 'image').length,
				scripts: nonHashedList.filter(r => r.type === 'script').length,
				stylesheets: nonHashedList.filter(r => r.type === 'stylesheet').length,
				other: nonHashedList.filter(r => r.type === 'other').length
			};

			logger.error(`Cache busting check failed: ${nonHashedResources.size} resources without hashes found`, {
				error: new Error(`Found ${nonHashedResources.size} non-hashed resources: ${JSON.stringify(nonHashedByType)}`)
			});
		} else {
			logger.info(`✓ All resources properly cache-busted with hashes`);
		}

		//Combined assertion.
		const totalIssues = brokenResources.size + nonHashedResources.size;
		expect(totalIssues, `Found ${brokenResources.size} broken resources and ${nonHashedResources.size} non-hashed resources`).toBe(0);
	}, 600000);
});
