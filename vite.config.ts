import * as cheerio from 'cheerio';
import { type Logger, type Plugin, type ResolvedConfig, type UserConfig, defineConfig } from 'vite';
import path, { relative, resolve } from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import fs from 'node:fs';
import glob from 'glob';


/**
 * Project configuration.
 */
const projectRoot = resolve(__dirname);

/**
 * Asset configuration settings.
 */
interface AssetConfig {
	/** Source directory for the project. */
	srcDir: string;
	/** Output directory for the build. */
	outputDir: string;
	/** Subdirectory for assets within the output directory. */
	assetsSubdir: string;
	/** Base URL for the site. */
	siteBaseUrl: string;
}

const assetConfig: AssetConfig = {
	srcDir: 'src',
	outputDir: 'dist',
	assetsSubdir: 'assets',
	siteBaseUrl: 'https://test.com'
};

/**
 * Represents an asset file entry with path information.
 */
interface AssetEntry {
	/** Original path relative to the source directory. */
	originalPath: string;
	/** Full filesystem path to the asset. */
	fullPath: string;
}

/**
 * Maps URL route paths to their corresponding HTML file metadata.
 */
interface HtmlFileMap {
	/**
	 * @param routePath - The URL path pattern (e.g. "about" for "/about.html")
	 * @returns Object containing file metadata
	 */
	[routePath: string]: {
		/**
		 * Absolute filesystem path to the HTML file.
		 * @example "/project/src/about.html"
		 */
		filePath: string;

		/**
		 * Normalized route identifier matching the URL pattern.
		 * @example
		 * - "index" for "/index.html"
		 * - "blog/post" for "/blog/post.html"
		 */
		routeKey: string;
	}
}

/**
 * Maps original asset paths to their hashed versions.
 * @example
 * {
 *   "images/logo.svg": "assets/images/logo-DaG69vPR.svg", // Original path -> Hashed path
 *   "styles/main.css": "assets/styles/main-AbC123de.css"
 * }
 */
interface AssetMappings {
	/**
	 * Maps from original asset path to its hashed version.
	 * @key Original asset path relative to source directory
	 * @value Hashed asset path relative to build directory
	 */
	[originalPath: string]: string;
}

/**
 * Recursively discovers all HTML files in a directory and maps them to route paths.
 *
 * @param dir - Directory to search (absolute path recommended)
 * @param root - Root directory for calculating relative routes
 * @returns Mapping of route paths to file information
 *
 * @example
 * const htmlFiles = getHtmlFiles('/project/src', '/project/src');
 * // Returns {
 * //   "about": {
 * //     filePath: "/project/src/about.html",
 * //     routeKey: "about"
 * //   }
 * // }
 */
const getHtmlFiles = (dir: string, root: string): HtmlFileMap => {
	const files: HtmlFileMap = {};

	const traverse = (currentDir: string): void => {
		for (const file of fs.readdirSync(currentDir, { withFileTypes: true })) {
			const fullPath = resolve(currentDir, file.name);

			if (file.isDirectory()) {
				traverse(fullPath);
			} else if (file.name.endsWith('.html')) {
				const relPath = relative(root, fullPath);
				const routeKey = relPath.replace(/\.html$/, '');

				files[routeKey] = {
					filePath: fullPath,
					routeKey
				};
			}
		}
	};

	traverse(dir);
	return files;
};



/**
 * Finds assets in a string by looking for URLs that match asset patterns.
 *
 * @param str - String to search for asset references
 * @param baseUrl - Base URL to identify absolute references
 * @param srcDir - Source directory to resolve asset paths
 * @returns Array of asset entries found in the string
 */
const findAssetsInString = (str: string, baseUrl: string, srcDir: string): AssetEntry[] => {
	const entries: AssetEntry[] = [];

	// Check if the string is a URL that might reference an asset.
	if ((str.includes(baseUrl) || str.startsWith('/')) &&
		/\.(jpg|jpeg|png|svg|gif|webp|avif|mp4|webm|ico)$/i.test(str)) {
		const assetPath = str.replace(baseUrl, '').replace(/^\/+/, '');
		const fullPath = path.join(srcDir, assetPath);

		if (fs.existsSync(fullPath)) {
			entries.push({
				originalPath: assetPath,
				fullPath
			});
		} else {
			// Try looking for the file with just the basename.
			const basename = path.basename(assetPath);
			const potentialPaths = glob.sync(`${srcDir}/**/${basename}`);

			if (potentialPaths.length > 0) {
				entries.push({
					originalPath: assetPath,
					fullPath: potentialPaths[0]
				});
			}
		}
	}

	return entries;
};

/**
 * Searches for assets in JSON data structures recursively.
 *
 * @param obj - JSON object to search for asset references
 * @param baseUrl - Base URL to identify absolute references
 * @param srcDir - Source directory to resolve asset paths
 * @returns Array of asset entries found in the JSON
 */
const findAssetsInJson = (obj: unknown, baseUrl: string, srcDir: string): AssetEntry[] => {
	if (!obj || typeof obj !== 'object') {
		return [];
	}

	const entries: AssetEntry[] = [];

	for (const [_key, value] of Object.entries(obj)) {
		if (typeof value === 'string') {
			entries.push(...findAssetsInString(value, baseUrl, srcDir));
		} else if (Array.isArray(value)) {
			value.forEach(item => {
				entries.push(...findAssetsInJson(item, baseUrl, srcDir));
			});
		} else if (typeof value === 'object' && value !== null) {
			entries.push(...findAssetsInJson(value, baseUrl, srcDir));
		}
	}

	return entries;
};


/**
 * Analyzes content that might be JSON or a string and finds asset references.
 *
 * @param content - Content to analyze
 * @param baseUrl - Base URL to identify absolute references
 * @param srcDir - Source directory to resolve asset paths
 * @returns Array of asset entries found
 */
const findAssetsInJsonOrString = (content: string, baseUrl: string, srcDir: string): AssetEntry[] => {
	// First check if it looks like JSON.
	const trimmed = content.trim();
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			const json = JSON.parse(content);
			return findAssetsInJson(json, baseUrl, srcDir);
		} catch {
			// If parsing fails, fall through to string processing.
		}
	}

	return findAssetsInString(content, baseUrl, srcDir);
};

/**
 * Finds unreferenced assets in HTML files by analyzing various tag types.
 *
 * @param srcDir - Source directory to search
 * @param baseUrl - Base URL for identifying references
 * @returns Object mapping asset paths to their full filesystem paths for Rollup input
 */
const findUnreferencedAssets = (srcDir: string, baseUrl: string): { [assetPath: string]: string } => {
	const htmlFiles = glob.sync(`${srcDir}/**/*.html`);
	const entries: { [assetPath: string]: string } = {};
	const processedAssets = new Set<string>();

	htmlFiles.forEach(htmlFile => {
		const content = fs.readFileSync(htmlFile, 'utf-8');
		const $ = cheerio.load(content);

		$('meta[property^="og:image"], meta[name^="twitter:image"], meta[name^="twitter:player:stream"]').each((_, el) => {
			const contentAttr = $(el).attr('content');
			if (contentAttr) {
				const foundAssets = findAssetsInString(contentAttr, baseUrl, srcDir);
				foundAssets.forEach(asset => {
					if (!processedAssets.has(asset.originalPath)) {
						entries[asset.fullPath] = asset.fullPath;
						processedAssets.add(asset.originalPath);
					}
				});
			}
		});

		//These are e.g. semantic information tags.
		$('script[type="application/ld+json"]').each((_, el) => {
			const scriptContent = $(el).html();
			if (scriptContent) {
				const foundAssets = findAssetsInJsonOrString(scriptContent, baseUrl, srcDir);
				foundAssets.forEach(asset => {
					if (!processedAssets.has(asset.originalPath)) {
						entries[asset.fullPath] = asset.fullPath;
						processedAssets.add(asset.originalPath);
					}
				});
			}
		});

		$('img').each((_, el) => {
			const src = $(el).attr('src');
			if (src) {
				const foundAssets = findAssetsInString(src, baseUrl, srcDir);
				foundAssets.forEach(asset => {
					if (!processedAssets.has(asset.originalPath)) {
						entries[asset.fullPath] = asset.fullPath;
						processedAssets.add(asset.originalPath);
					}
				});
			}
		});
	});

	//Manifest.json contains asset references too.
	const manifestPath = path.join(srcDir, 'manifest.json');
	if (fs.existsSync(manifestPath)) {
		const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
		const foundAssets = findAssetsInJsonOrString(manifestContent, baseUrl, srcDir);
		foundAssets.forEach(asset => {
			if (!processedAssets.has(asset.originalPath)) {
				entries[asset.fullPath] = asset.fullPath;
				processedAssets.add(asset.originalPath);
			}
		});
	}

	return entries;
};

/**
 * Creates a mapping of original asset paths to their hashed versions.
 *
 * @param baseDir - Base directory for the project
 * @param assetsDir - Directory containing assets
 * @param logger - Vite logger for reporting progress.
 * @returns Record mapping original asset paths to their hashed versions
 */
const createAssetMappings = (baseDir: string, assetsDir: string, logger: Logger): AssetMappings => {
	const assetMappings: AssetMappings = {};

	const assetFiles = glob.sync(`${assetsDir}/**/*.{jpg,jpeg,png,svg,gif,webp,avif,mp4,webm,css,js,json}`);

	logger.info(`Found ${assetFiles.length} asset files in ${assetsDir}`);

	assetFiles.forEach(assetFile => {
		const fileName = path.basename(assetFile);

		// Only process files with a hash added to the filename.
		if (!fileName.match(/-[a-zA-Z0-9_]+\.[a-z]+$/)) {
			return;
		}

		const originalName = fileName.replace(/-[a-zA-Z0-9_]+(\.[a-z]+)$/, '$1');
		const dirRelative = path.dirname(path.relative(assetsDir, assetFile)).replace(/\\/g, '/');
		const originalPath = dirRelative === '.' ? originalName : `${dirRelative}/${originalName}`;
		const relativePath = path.relative(baseDir, assetFile).replace(/\\/g, '/');

		assetMappings[originalPath] = relativePath;
	});

	// Add an additional mapping for direct paths (without directories).
	// This helps match paths that might be referenced without their directory structure.
	assetFiles.forEach(assetFile => {
		const fileName = path.basename(assetFile);
		if (!fileName.match(/-[a-zA-Z0-9_]+\.[a-z]+$/)) {
			return;
		}

		const originalName = fileName.replace(/-[a-zA-Z0-9_]+(\.[a-z]+)$/, '$1');
		const relativePath = path.relative(baseDir, assetFile).replace(/\\/g, '/');

		// Add the base filename as a key too.
		assetMappings[originalName] = relativePath;
	});

	return assetMappings;
};


/**
 * Updates a URL to use the hashed asset path if available.
 *
 * @param url - URL to potentially update
 * @param assetMappings - Mapping of original asset paths to hashed versions
 * @returns Updated URL or original if no mapping exists
 */
const updateUrl = (url: string, assetMappings: AssetMappings): string => {
	const isAbsolute = url.startsWith(assetConfig.siteBaseUrl);
	let assetPath = url;

	if (isAbsolute) {
		assetPath = url.slice(assetConfig.siteBaseUrl.length);
	}

	assetPath = assetPath.replace(/^\/+/, '');

	if (assetMappings[assetPath]) {
		const hashedPath = assetMappings[assetPath];
		return isAbsolute ? `${assetConfig.siteBaseUrl}/${hashedPath}` : `/${hashedPath}`;
	}

	return url;
};

/**
 * Recursively processes manifest JSON to update URLs.
 *
 * @param obj - Object to update
 * @param assetMappings - Mapping of original asset paths to hashed versions
 * @returns Whether any values were changed
 */
const processManifestUrls = (obj: unknown, assetMappings: AssetMappings): boolean => {
	if (!obj || typeof obj !== 'object') {
		return false;
	}

	let changed = false;
	const typedObj = obj as Record<string, unknown>;

	Object.keys(typedObj).forEach(key => {
		if (key !== 'icons' && typeof typedObj[key] === 'string') {
			const newVal = updateUrl(typedObj[key] as string, assetMappings);
			if (newVal !== typedObj[key]) {
				typedObj[key] = newVal;
				changed = true;
			}
		} else if (Array.isArray(typedObj[key])) {
			const arr = typedObj[key] as unknown[];
			arr.forEach((item, index) => {
				if (typeof item === 'string') {
					const newVal = updateUrl(item, assetMappings);
					if (newVal !== item) {
						arr[index] = newVal;
						changed = true;
					}
				} else if (processManifestUrls(item, assetMappings)) {
					changed = true;
				}
			});
		} else if (typeof typedObj[key] === 'object' && processManifestUrls(typedObj[key], assetMappings)) {
			changed = true;
		}
	});

	return changed;
};

/**
 * JSON indentation level for pretty-printing.
 */
const JSON_INDENT_SPACES = 2;
/**
 * Fixes common issues in a MIME type string.
 *
 * @param mimeType - The MIME type string to fix
 * @returns The corrected MIME type string
 */
const fixMimeType = (mimeType: string): string => {
	if (!mimeType) {
		return mimeType;
	}

	// Fix duplicate prefixes like "image/image/".
	return mimeType.replace(/^(image|audio|video|application)\/(image|audio|video|application)\//, '$1/');
};

/**
 * Updates a manifest.json file with hashed asset URLs.
 *
 * @param manifestPath - Path to the manifest file
 * @param assetMappings - Mapping of original asset paths to hashed versions
 * @param logger - Vite logger for reporting updates
 * @returns Whether the manifest was updated
 */
const updateManifestFile = (
	manifestPath: string,
	assetMappings: AssetMappings,
	logger: Logger
): boolean => {
	if (!fs.existsSync(manifestPath)) {
		return false;
	}

	try {
		const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
		const manifest = JSON.parse(manifestContent);
		let updated = false;

		//Process icons array.
		if (manifest.icons && Array.isArray(manifest.icons)) {
			manifest.icons = manifest.icons.map((icon: any) => {
				const newIcon = { ...icon };
				if (icon.src) {
					newIcon.src = updateUrl(icon.src, assetMappings);
					if (newIcon.src !== icon.src) {
						updated = true;
					}
				}

				//Fix the type attribute if it's malformed.
				if (icon.type) {
					const fixedType = fixMimeType(icon.type);
					if (fixedType !== icon.type) {
						newIcon.type = fixedType;
						updated = true;
						logger.info(`Fixed malformed MIME type in manifest: "${icon.type}" → "${fixedType}"`, {
							timestamp: true
						});
					}
				}

				return newIcon;
			});
		}

		//Process other potential asset URLs.
		if (processManifestUrls(manifest, assetMappings) || updated) {
			fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, JSON_INDENT_SPACES));
			logger.info(`Updated manifest file: ${path.relative(process.cwd(), manifestPath)}`, {
				timestamp: true
			});

			return true;
		}
	} catch (e) {
		logger.error(`Failed to update manifest.json: ${e}`, {
			timestamp: true
		});
	}

	return false;
};


/**
 * Updates HTML files to reference hashed asset paths.
 *
 * @param baseDir - Base directory for the project
 * @param assetMappings - Mapping of original asset paths to hashed versions
 * @param logger - Vite logger for reporting updates
 */
const updateHtmlFiles = (
	baseDir: string,
	assetMappings: AssetMappings,
	logger: Logger
): void => {
	//Log the asset mappings for debugging.
	logger.info(`Asset mappings: ${Object.keys(assetMappings).length} entries`, { timestamp: true	});

	Object.entries(assetMappings).forEach(([key, value]) => {
		logger.info(`  ${key} -> ${value}`, {
			timestamp: true
		});
	});


	//Process manifest.json files first.
	const manifestFiles = glob.sync(`${baseDir}/**/manifest*.json`);
	manifestFiles.forEach(manifestPath => {
		if (updateManifestFile(manifestPath, assetMappings, logger)) {
			logger.info(`Successfully updated ${path.relative(baseDir, manifestPath)} with hashed asset URLs`, {
				timestamp: true
			});
		}
	});

	//Then process HTML files.
	const htmlFiles = glob.sync(`${baseDir}/**/*.html`);
	logger.info(`Found ${htmlFiles.length} HTML files to process`, {
		timestamp: true
	});

	let updatedFileCount = 0;
	const updatedFiles: string[] = [];

	htmlFiles.forEach(htmlFile => {
		const relativePath = path.relative(baseDir, htmlFile);
		logger.info(`Processing HTML file: ${relativePath}`, {
			timestamp: true
		});

		const content = fs.readFileSync(htmlFile, 'utf-8');
		const $ = cheerio.load(content);
		let fileChanged = false;
		let changesCount = 0;

		//Update manifest link.
		$('link[rel="manifest"]').each((_, el) => {
			const $el = $(el);
			const href = $el.attr('href');
			if (href && href.endsWith('manifest.json')) {
				//Find the hashed manifest file...
				const manifestFiles = glob.sync(`${baseDir}/**/manifest-*.json`);
				if (manifestFiles.length > 0) {
					const relativeManifestPath = path.relative(baseDir, manifestFiles[0]).replace(/\\/g, '/');
					$el.attr('href', `/${relativeManifestPath}`);
					fileChanged = true;
					changesCount++;
				}
			}
		});

		//Handle special case for service worker.
		$('script').each((_, el) => {
			const $el = $(el);
			const content = $el.html();

			// Look for service worker registration in script content.
			if (content && content.includes('serviceWorker') && content.includes('register')) {
				// Check if it's using dynamic import.meta.url pattern.
				if (content.includes('new URL') && content.includes('import.meta.url')) {
					// We need to keep this as-is since it uses runtime URL resolution.
					// No changes needed.
				} else {
					// If it's a static path, we should update it.
					const matches = content.match(/register\(['"]([^'"]+)['"]/);
					if (matches && matches[1]) {
						const oldPath = matches[1];
						const newPath = updateUrl(oldPath, assetMappings);
						if (oldPath !== newPath) {
							$el.html(content.replace(oldPath, newPath));
							fileChanged = true;
							changesCount++;
						}
					}
				}
			}
		});

		//Update elements with src, href, or content attributes.
		$('[src],[href],[content]').each((_, el) => {
			const $el = $(el);
			const nodeName = el.tagName.toLowerCase();

			['src', 'href', 'content', 'srcset'].forEach(attr => {
				const value = $el.attr(attr);
				if (value) {
					//Skip certain links that shouldn't be processed.
					if (attr === 'href' && nodeName === 'a' && !value.match(/\.(html|css|js|json)$/i)) {
						return;
					}

					//Handle srcset attribute specially.
					if (attr === 'srcset') {
						const srcsets = value.split(',').map(srcset => {
							const [url, descriptor] = srcset.trim().split(/\s+/);
							return `${updateUrl(url, assetMappings)}${descriptor ? ' ' + descriptor : ''}`;
						});

						const newSrcset = srcsets.join(', ');
						if (newSrcset !== value) {
							$el.attr(attr, newSrcset);
							fileChanged = true;
							changesCount++;
						}
						return;
					}

					const updatedValue = updateUrl(value, assetMappings);
					if (updatedValue !== value) {
						$el.attr(attr, updatedValue);
						fileChanged = true;
						changesCount++;
					}
				}
			});
		});

		// Update JSON-LD scripts.
		let jsonChangesCount = 0;
		$('script[type="application/ld+json"]').each((_, el) => {
			const script = $(el);
			let scriptContent = script.html() || '';
			try {
				const jsonContent = JSON.parse(scriptContent);
				const initialJson = JSON.stringify(jsonContent);

				//Process all fields recursively to update image URLs.
				const processJsonValues = (obj: unknown) => {
					if (!obj || typeof obj !== 'object') {
						return;
					}

					Object.entries(obj).forEach(([key, value]) => {
						//Check for common image fields.
						if (typeof value === 'string' &&
							(key === 'image' || key === 'logo' || key === 'thumbnail' ||
								key.includes('Image') || key.includes('image'))) {
							obj[key] = updateUrl(value as string, assetMappings);
							jsonChangesCount++;
						} else if (Array.isArray(value)) {
							value.forEach(item => {
								if (typeof item === 'object') {
									processJsonValues(item);
								} else if (typeof item === 'string') {
									//Try to detect URLs in arrays...
									if (item.includes('http') || item.startsWith('/')) {
										const updatedUrl = updateUrl(item, assetMappings);
										if (updatedUrl !== item) {
											obj[key] = (obj[key] as string[]).map(str =>
												str === item ? updatedUrl : str
											);
											jsonChangesCount++;
										}
									}
								}
							});
						} else if (typeof value === 'object') {
							processJsonValues(value);
						}
					});
				};

				processJsonValues(jsonContent);

				const updatedJson = JSON.stringify(jsonContent, null, JSON_INDENT_SPACES);
				if (initialJson !== updatedJson) {
					script.html(updatedJson);
					fileChanged = true;
					jsonChangesCount++;
				}
			} catch (e) {
				//If not valid JSON, treat as string.
				const updatedContent = updateUrl(scriptContent, assetMappings);
				if (updatedContent !== scriptContent) {
					script.html(updatedContent);
					fileChanged = true;
					jsonChangesCount++;
				}
			}
		});

		changesCount += jsonChangesCount;

		//Only write the file if changes were made.
		if (fileChanged) {
			fs.writeFileSync(htmlFile, $.html());
			updatedFiles.push(relativePath);
			logger.info(`Updated ${relativePath} with ${changesCount} changes`, {
				timestamp: true
			});
		} else {
			logger.info(`No changes needed for ${relativePath}`, {
				timestamp: true
			});
		}
	});

	if (updatedFileCount > 0) {
		logger.info(`Updated ${updatedFileCount} of ${htmlFiles.length} HTML files with hashed asset URLs:`, {
			timestamp: true
		});
		updatedFiles.forEach(file => {
			logger.info(`  - ${file}`, { timestamp: true });
		});
	}
};

/**
 * Creates a Vite plugin that processes assets after the build is complete.
 *
 * @returns Vite plugin
 */
const postBuildAssetsPlugin = (): Plugin => {
	let config: ResolvedConfig = {} as ResolvedConfig;

	return {
		name: 'post-build-assets',
		apply: 'build',
		configResolved(resolvedConfig) {
			config = resolvedConfig;
		},
		closeBundle() {
			const distDir = resolve(projectRoot, assetConfig.outputDir);
			const clientDir = resolve(distDir, 'client');

			//Check if it's a Cloudflare build based on build options or environment.
			if (config.build.ssr
				&& process.env.CLOUDFLARE_BUILD === 'true') {
					return;
			}


			if (!fs.existsSync(clientDir)) {
				config.logger.error(`Client directory not found at ${clientDir}.`, {
					timestamp: true
				});

				return;
			}

			config.logger.info(`Processing asset mappings for build...`, {
				timestamp: true,
				clear: true
			});

			const assetsDir = resolve(clientDir, assetConfig.assetsSubdir);
			const assetMappings = createAssetMappings(clientDir, assetsDir, config.logger);

			config.logger.info(`Found ${Object.keys(assetMappings).length}:`, { timestamp: true});
			updateHtmlFiles(clientDir, assetMappings, config.logger);
			config.logger.info(`Post-build asset processing complete.`, { timestamp: true});
		}
	};
};

/**
 * Asset path validator plugin.
 *
 * This plugin validates that input files exist before building.
 * It handles different build phases in the Vite + Cloudflare integration:
 * 1. Client build phase (object with multiple entry points)
 * 2. Cloudflare Worker build phase (single string path)
 *
 * Note: The post-build assets plugin will run after each build phase completes,
 * which is why we see the asset processing logs multiple times in the output.
 *
 * @returns Vite plugin
 */
const assetPathValidatorPlugin = (): Plugin => {
	return {
		name: 'asset-path-validator',
		configResolved(config) {
			//Early detection for Cloudflare Worker build.
			//Check if this is a Cloudflare Worker build based on input type and content.
			const inputs = config.build.rollupOptions?.input;

			//Exit early if no inputs defined..
			if (!inputs) {
				return;
			}

			//Exit early for Cloudflare Worker builds (single string input).
			if (typeof inputs === 'string') {
				//Skip validation completely for Cloudflare builds.
				config.logger.info('Detected Cloudflare Worker build, skipping validation', {
					timestamp: true
				});
				return;
			}

			//Check if it's a Cloudflare build based on build options or environment.
			if (config.build.ssr ||
				process.env.CLOUDFLARE_BUILD === 'true' ||
				(config.plugins || []).some(p => p.name?.includes('cloudflare'))) {
				config.logger.info('Detected Cloudflare build context, skipping validation', {
					timestamp: true
				});

				return;
			}

			//Process normal client build (continue with validation).
			const inputFiles = Object.values(inputs) as string[];
			const missingFiles = inputFiles.filter(file => !fs.existsSync(file));

			if (missingFiles.length > 0) {
				config.logger.warn(`Found ${missingFiles.length} missing input files:`, {
					timestamp: true
				});

				missingFiles.forEach(file => {
					config.logger.error(`Input file not found: ${file}`, {
						timestamp: true
					});
				});
			} else {
				config.logger.info('All input files found', {
					timestamp: true
				});
			}
		}
	};
};

/**
 * Calculate the depth of an asset path to maintain directory structure.
 *
 * @param filePath - File path to analyze
 * @returns Number of characters to skip at the beginning of the path
 */
const getAssetsDepth = (filePath: string): number => {
	const normalized = path.normalize(filePath).replace(/\\/g, '/');
	return normalized.startsWith('src/') ? 'src/'.length : 0;
};

export default defineConfig(({ mode }) => {
	const DEFAULT_PORT = 9229;
	const NO_CACHE_MAX_AGE = 0;
	const isDev = mode === 'development';
	const isTest = mode === 'test';

	const htmlFiles = getHtmlFiles('src', resolve(projectRoot, 'src'));

	//Convert to Rollup input format.
	const rollupInput = Object.fromEntries(
		Object.entries(htmlFiles).map(([routeKey, { filePath }]) => [routeKey, filePath])
	);


	/*console.log('Rollup inputs:', Object.entries({
		...findUnreferencedAssets('src', assetConfig.siteBaseUrl),
		...rollupInput,
		'service-worker': resolve(projectRoot, 'public/service-worker.js')
	}).map(([key, value]) => {
		return `${key}: ${value}`;
	}));*/

	const config: UserConfig = {
		root: assetConfig.srcDir,
		publicDir: 'public',
		build: {
			assetsInlineLimit: 0,
			emptyOutDir: true,
			outDir: '../dist',
			minify: true,
			cssMinify: true,
			cssCodeSplit: true,
			rollupOptions: {
				input: {
					...findUnreferencedAssets('src', assetConfig.siteBaseUrl),
					...rollupInput,
					'service-worker': resolve(projectRoot, 'public/service-worker.js')
				},
				output: {
					entryFileNames: (chunkInfo) => {
						// Files that should maintain consistent names (no hash).
						const noHashFiles = ['background', 'content', 'service-worker'];
						return noHashFiles.includes(chunkInfo.name)
							? '[name].js'
							: 'assets/[name]-[hash].js';
					},
					chunkFileNames: 'assets/[name]-[hash].js',
					assetFileNames: (assetInfo) => {
						if (assetInfo.name === 'manifest.json' ||
							(assetInfo.originalFileNames?.some(name => name.endsWith('manifest.json')))) {
							return 'assets/manifest-[hash][extname]';
						}

						if (assetInfo.originalFileNames && assetInfo.originalFileNames.length > 0) {
							let originalFile = assetInfo.originalFileNames[0];
							if (/\.(json|jpg|jpeg|png|svg|gif|webp|avif|mp4|webm)$/i.test(originalFile)) {
								if (originalFile.startsWith('src/')) {
									originalFile = originalFile.slice(4);
								}
								const normalizedPath = path.normalize(originalFile).replace(/\\/g, '/');
								const depth = getAssetsDepth(normalizedPath);
								const cleanPath = depth > 0 ? normalizedPath.slice(depth) : normalizedPath;
								const [name, ...extParts] = cleanPath.split('.');
								const ext = extParts.pop();
								return ext
									? `assets/${name}-[hash].${ext}`
									: `assets/${cleanPath}-[hash]`;
							}
						}
						return 'assets/[hash][extname]';
					}
				}
			}
		},
		css: {
			devSourcemap: true
		},
		plugins: [
			cloudflare({
				configPath: resolve(__dirname, 'wrangler.jsonc'),
				inspectorPort: isTest
					? parseInt(process.env.CLOUDFLARE_INSPECTOR_PORT ?? '0')
					: DEFAULT_PORT
			}),
			assetPathValidatorPlugin(),
			postBuildAssetsPlugin()
		],
		// Development-specific configuration.
		...(isDev && {
			server: {
				fs: { strict: true },
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Cache-Control': `no-store, max-age=${NO_CACHE_MAX_AGE}`
				}
			}
		}),
		// Add logging configuration.
		logLevel: isDev ? 'info' : 'info' // Always use info level for better visibility
	};

	return config;
});
