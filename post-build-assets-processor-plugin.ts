import * as cheerio from 'cheerio';
import type { Logger, Plugin, ResolvedConfig } from 'vite';
import path, { resolve } from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { glob } from 'glob';


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
 * Represents an icon entry in a Web App Manifest.
 * Each icon provides a fallback for various device requirements.
 *
 * See: https://developer.mozilla.org/en-US/docs/Web/Manifest/icons
 */
interface ManifestIcon {
	/** The path to the icon file, relative to the manifest or as an absolute URL. */
	src: string;

	/**
	 * A space-separated list of icon dimensions, e.g. "48x48".
	 * Helps the browser choose the most appropriate icon.
	 */
	sizes?: string;

	/**
	 * The MIME type of the icon, e.g. "image/png".
	 * Helps identify and filter image formats.
	 */
	type?: string;

	/**
	 * The intended usage purpose(s) for the icon.
	 * Can be one or more of: "any", "maskable", "monochrome".
	 */
	purpose?: string;
}



/**
 * Maps original asset paths to their hashed versions.
 * @example
 * {
 *   "images/logo.svg": "assets/images/logo-DaG69vPR.svg", //Original path -> Hashed path.
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
 * Finds assets in a string by looking for URLs that match asset patterns.
 *
 * @param str - String to search for asset references
 * @param baseUrl - Base URL to identify absolute references
 * @param srcDir - Source directory to resolve asset paths
 * @returns Array of asset entries found in the string
 */
const findAssetsInString = (
	str: string,
	baseUrl: string,
	srcDir: string
): AssetEntry[] => {
	const entries: AssetEntry[] = []

	//Strip origin if present.
	let p = str.startsWith(baseUrl) ? str.slice(baseUrl.length) : str
	p = p.split(/[?#]/)[0].replace(/^\/+/, '')  // drop query/hash & leading slash

	//Only match known extensions.
	if (!/\.(jpg|jpeg|png|svg|gif|webp|avif|mp4|webm|ico)$/i.test(p)) {
		return entries
	}

	//1) direct file under srcDir.
	const direct = path.join(srcDir, p)
	if (fs.existsSync(direct)) {
		entries.push({ originalPath: p, fullPath: direct })
		return entries
	}

	//2) Fallback: glob basename anywhere under srcDir.
	const name = path.basename(p)
	const matches = glob.sync(`${srcDir}/**/${name}`)
	if (matches.length > 0) {
		entries.push({ originalPath: p, fullPath: matches[0] })
	}

	return entries
}


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
	//First check if it looks like JSON.
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
const findUnreferencedAssets = (
	srcDir: string,
	baseUrl: string,
	logger: Logger
): { [key: string]: string } => {
	const htmlFiles = glob.sync(`${srcDir}/**/*.html`);
	const entries: { [key: string]: string } = {};
	const seen = new Set<string>();

	htmlFiles.forEach(htmlFile => {
		const content = fs.readFileSync(htmlFile, 'utf8');
		const $ = cheerio.load(content);

		//1) <meta property="og:image">,
		//   <meta name="twitter:image">,
		//   <meta name="twitter:player:stream">
		$('meta[property^="og:image"], meta[name^="twitter:image"], meta[name^="twitter:player:stream"]')
			.each((_, el) => {
				const url = $(el).attr('content');
				if (url) {
					findAssetsInString(url, baseUrl, srcDir).forEach(a => {
						logger.info(`Found asset in meta: ${a.originalPath}`, { timestamp: true });
						if (!seen.has(a.originalPath)) {
							entries[a.originalPath] = a.fullPath;
							seen.add(a.originalPath);
						}
					});
				}
			});

		//2) <img src="...">.
		$('img').each((_, el) => {
			const url = $(el).attr('src');
			if (url) {
				findAssetsInString(url, baseUrl, srcDir).forEach(a => {
					if (!seen.has(a.originalPath)) {
						entries[a.originalPath] = a.fullPath;
						seen.add(a.originalPath);
					}
				});
			}
		});

		//3) JSON-LD scripts.
		$('script[type="application/ld+json"]').each((_, el) => {
			const scriptContent = $(el).html();
			if (scriptContent) {
				try {
					const json = JSON.parse(scriptContent);
					findAssetsInJson(json, baseUrl, srcDir).forEach(a => {
						if (!seen.has(a.originalPath)) {
							entries[a.originalPath] = a.fullPath;
							seen.add(a.originalPath);
						}
					});
				} catch {
					//If not valid JSON, treat as string
					findAssetsInString(scriptContent, baseUrl, srcDir).forEach(a => {
						if (!seen.has(a.originalPath)) {
							entries[a.originalPath] = a.fullPath;
							seen.add(a.originalPath);
						}
					});
				}
			}
		});
	});

	//4) Also scan manifest.json if it exists.
	const manifestPath = path.join(srcDir, 'manifest.json');
	if (fs.existsSync(manifestPath)) {
		const mf = fs.readFileSync(manifestPath, 'utf8');
		findAssetsInJsonOrString(mf, baseUrl, srcDir).forEach(a => {
			if (!seen.has(a.originalPath)) {
				entries[a.originalPath] = a.fullPath;
				seen.add(a.originalPath);
			}
		});
	}

	logger.info(`🔑 entries: ${Object.keys(entries).sort().join(', ')}`);

	return entries;
};


/**
 * Handles missing assets by copying them to the output directory with a hashed filename.
 *
 * @param baseDir - Base directory for the project
 * @param assetsDir - Directory containing assets
 * @param assetConfig - Asset configuration settings
 * @param assetMappings - Mapping of original asset paths to hashed versions
 * @param logger - Vite logger for reporting progress
 * @returns Updated asset mappings with missing assets handled
 */
const processMissingAssets = (
  baseDir: string,
  assetsDir: string,
	assetConfig: AssetConfig,
  assetMappings: AssetMappings,
  logger: Logger
): AssetMappings => {

	//Gather source assets to compare against ones in build target
	//to cross check for missing assets.
  const sourceAssets = findUnreferencedAssets('src', assetConfig.siteBaseUrl, logger);
  const updatedMappings = { ...assetMappings };
  const missingAssets: string[] = [];

  //Find assets missing from the mappings.
  for (const [sourcePath, _fullSourcePath] of Object.entries(sourceAssets)) {
    if (!assetMappings[sourcePath]) {
      missingAssets.push(sourcePath);
      logger.warn(`Asset missing in output: ${sourcePath}`, { timestamp: true });
    }
  }

  //Handle missing assets, add also hash to file name for cache busting.
  if (missingAssets.length > 0) {
    logger.warn(`Found ${missingAssets.length} assets missing in build output:`, { timestamp: true });

    for (const missingAsset of missingAssets) {
      try {
        const sourcePath = sourceAssets[missingAsset];

        //Read file content for hashing.
        const fileContent = fs.readFileSync(sourcePath);
        const hash = crypto
          .createHash('md5')
          .update(fileContent)
          .digest('hex')
          .substring(0, 8);

        //Parse the asset path
        const parsedAsset = path.parse(missingAsset);
        const dirname = parsedAsset.dir;
        const basename = parsedAsset.name;
        const ext = parsedAsset.ext;

        //.Create target directory in assets folder (if not already present).
        const assetDir = dirname ? `${dirname}` : '';
        const targetDir = path.join(assetsDir, assetDir);

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        //Create hashed filename.
        const hashedFilename = `${basename}-${hash}${ext}`;
        const targetPath = path.join(targetDir, hashedFilename);

        //Copy the file.
        fs.copyFileSync(sourcePath, targetPath);

        //Create relative path for mapping.
        const relativeTargetPath = path.relative(baseDir, targetPath).replace(/\\/g, '/');

        //Add to mappings.
        updatedMappings[missingAsset] = relativeTargetPath;

        logger.info(`Copied missing asset: ${sourcePath} -> ${targetPath}`, { timestamp: true });
        logger.info(`Added mapping: ${missingAsset} -> ${relativeTargetPath}`, { timestamp: true });

      } catch (err) {
        logger.error(`Failed to copy missing asset: ${err}`, { timestamp: true });
      }
    }
  }

  return updatedMappings;
};


/**
 * Creates a mapping of original asset paths to their hashed versions.
 * This improved version starts with source assets and cross-checks with output files.
 *
 * @param baseDir - Base directory for the project
 * @param assetsDir - Directory containing assets
 * @param logger - Vite logger for reporting progress.
 * @returns Record mapping original asset paths to their hashed versions
 */
const createAssetMappings = (
	baseDir: string,
	assetsDir: string,
	logger: Logger
): AssetMappings => {
	const mappings: AssetMappings = {};

	//Find all hashed assets in the output directory.
	const outputFiles = glob.sync(`${assetsDir}/**/*.{jpg,jpeg,png,svg,gif,webp,avif,mp4,webm,css,js,json}`);

	logger.info(`Found ${outputFiles.length} output files`, { timestamp: true });

	//Create mappings for all files in the output.
	for (const outputFile of outputFiles) {
		const relativePath = path.relative(baseDir, outputFile).replace(/\\/g, '/');
		const parsed = path.parse(relativePath);

		//Skip files without hash pattern.
		const parts = parsed.name.split('-');
		if (parts.length < 2) {
			continue;
		}

		//The basename without the hash.
		const baseName = parts.slice(0, -1).join('-');
		const directory = parsed.dir.replace(/^assets\//, '');

		//Create key that includes directory path, filename, and extension.
		const fullKey = directory	? `${directory}/${baseName}${parsed.ext}`	: `${baseName}${parsed.ext}`;
		mappings[fullKey] = relativePath;
		logger.info(`Mapped output file: ${fullKey} -> ${relativePath}.`, { timestamp: true });

		//Also add bare name for root-level files.
		if (!directory) {
			mappings[`${baseName}${parsed.ext}`] = relativePath;
		}
	}

	logger.info(`Created ${Object.keys(mappings).length} mappings from output files.`, { timestamp: true });

	return mappings;
};


/**
 * Updates a URL to use the hashed asset path if available.
 *
 * @param url - URL to potentially update
 * @param assetMappings - Mapping of original asset paths to hashed versions
 * @param assetConfig - Asset configuration settings.
 * @returns Updated URL or original if no mapping exists
 */
const updateUrl = (url: string, assetConfig: AssetConfig, assetMappings: AssetMappings): string => {
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
 * @param obj - Object to update.
 * @param assetConfig - Asset configuration settings.
 * @param assetMappings - Mapping of original asset paths to hashed versions.
 * @returns Whether any values were changed.
 */
const processManifestUrls = (obj: unknown, assetConfig: AssetConfig, assetMappings: AssetMappings): boolean => {
	if (!obj || typeof obj !== 'object') {
		return false;
	}

	let changed = false;
	const typedObj = obj as { [key: string]: unknown };

	Object.keys(typedObj).forEach(key => {
		if (key !== 'icons' && typeof typedObj[key] === 'string') {
			const newVal = updateUrl(typedObj[key] as string, assetConfig, assetMappings);
			if (newVal !== typedObj[key]) {
				typedObj[key] = newVal;
				changed = true;
			}
		} else if (Array.isArray(typedObj[key])) {
			const arr = typedObj[key] as unknown[];
			arr.forEach((item, index) => {
				if (typeof item === 'string') {
					const newVal = updateUrl(item, assetConfig, assetMappings);
					if (newVal !== item) {
						arr[index] = newVal;
						changed = true;
					}
				} else if (processManifestUrls(item, assetConfig, assetMappings)) {
					changed = true;
				}
			});
		} else if (typeof typedObj[key] === 'object' && processManifestUrls(typedObj[key],  assetConfig, assetMappings)) {
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
 * @param manifestPath - Path to the manifest file.
 * @param assetConfig - Asset configuration settings.
 * @param assetMappings - Mapping of original asset paths to hashed versions.
 * @param logger - Vite logger for reporting updates.
 * @returns Whether the manifest was updated.
 */
const updateManifestFile = (manifestPath: string,	assetConfig: AssetConfig,	assetMappings: AssetMappings,	logger: Logger): boolean => {
	if (!fs.existsSync(manifestPath)) {
		return false;
	}

	try {
		const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
		const manifest = JSON.parse(manifestContent);
		let updated = false;

		//Process icons array.
		if (manifest.icons && Array.isArray(manifest.icons)) {
			manifest.icons = manifest.icons.map((icon: ManifestIcon) => {
				const newIcon = { ...icon };

				if (icon.src) {
					newIcon.src = updateUrl(icon.src, assetConfig, assetMappings);
					if (newIcon.src !== icon.src) {
						updated = true;
					}
				}

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
		if (processManifestUrls(manifest, assetConfig, assetMappings) || updated) {
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
	assetConfig: AssetConfig,
	assetMappings: AssetMappings,
	logger: Logger
): void => {
	//Log the asset mappings for debugging.
	logger.info(`Asset mappings: ${Object.keys(assetMappings).length} entries`, { timestamp: true });

	Object.entries(assetMappings).forEach(([key, value]) => {
		logger.info(`  ${key} -> ${value}`, {
			timestamp: true
		});
	});


	//Process manifest.json files first.
	const manifestFiles = glob.sync(`${baseDir}/**/manifest*.json`);
	manifestFiles.forEach(manifestPath => {
		if (updateManifestFile(manifestPath, assetConfig, assetMappings, logger)) {
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
							return `${updateUrl(url, assetConfig, assetMappings)}${descriptor ? ' ' + descriptor : ''}`;
						});

						const newSrcset = srcsets.join(', ');
						if (newSrcset !== value) {
							$el.attr(attr, newSrcset);
							fileChanged = true;
							changesCount++;
						}
						return;
					}

					const updatedValue = updateUrl(value, assetConfig, assetMappings);
					if (updatedValue !== value) {
						$el.attr(attr, updatedValue);
						fileChanged = true;
						changesCount++;
					}
				}
			});
		});

		//Update JSON-LD scripts.
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

					const typedObj = obj as { [key: string]: unknown };

					Object.entries(typedObj).forEach(([key, value]) => {
						//Check for direct image URLs in common image fields...
						if (typeof value === 'string' && (
							key === 'image' ||
							key === 'logo' ||
							key === 'thumbnail' ||
							key === 'url' ||  // Also check for 'url' fields which often contain image paths
							key.includes('Image') ||
							key.includes('image')
						)) {
							typedObj[key] = updateUrl(value, assetConfig, assetMappings);
							jsonChangesCount++;
						}

						//Handle nested objects that might contain image URLs...
						else if (value && typeof value === 'object') {
							const isImageObject = (v: object): v is { url: string } => {
								return 'url' in v && typeof (v as { url: unknown }).url === 'string';
							};

							//Special case for image-like objects with url property...
							if (
								(key === 'image' || key === 'logo' || key.includes('Image') || key.includes('image')) && !Array.isArray(value) && isImageObject(value)
							) {
								//Direct update for known image objects with url property...
								value.url = updateUrl(value.url, assetConfig, assetMappings);
								jsonChangesCount++;
							}

							//Continue recursion for nested objects and arrays...
							if (Array.isArray(value)) {
								value.forEach((item, index) => {
									if (typeof item === 'object' && item !== null) {
										processJsonValues(item);
									} else if (typeof item === 'string') {
										//Try to detect URLs in arrays...
										if (item.includes('http') || item.startsWith('/')) {
											const updatedUrl = updateUrl(item, assetConfig, assetMappings);
											if (updatedUrl !== item) {
												(value as string[])[index] = updatedUrl;
												jsonChangesCount++;
											}
										}
									}
								});
							} else {
								//Regular object recursion...
								processJsonValues(value);
							}
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
			} catch {
				//If not valid JSON, treat as string.
				const updatedContent = updateUrl(scriptContent, assetConfig, assetMappings);
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
const PostBuildAssetsProcessorPlugin  = (options: {
  assetConfig: AssetConfig,
  projectRoot: string
}): Plugin => {

	if (!options || !options.assetConfig) {
    throw new Error('PostBuildAssetsProcessorPlugin: assetConfig is required');
  }

	const assetConfig = options.assetConfig;
	const root = options?.projectRoot || process.cwd();

	let resolvedConfig: ResolvedConfig = null as unknown as ResolvedConfig;

	return {
		name: 'post-build-assets-processor',
		apply: 'build',
		configResolved(config: ResolvedConfig) {
			resolvedConfig = config;
    },
		closeBundle() {
      const logger = resolvedConfig.logger;
      const distDir = resolve(root, assetConfig.outputDir);
      const clientDir = resolve(distDir, 'client');

      // Now you can use logger and config
      logger.info(`Processing asset mappings for build...`, {
        timestamp: true,
        clear: true
      });

			// Skip for Cloudflare builds
			if (resolvedConfig.build.ssr && process.env.CLOUDFLARE_BUILD === 'true') {
				return;
			}

			if (!fs.existsSync(clientDir)) {
				resolvedConfig.logger.error(`Client directory not found at ${clientDir}.`, {
					timestamp: true
				});
				return;
			}

			resolvedConfig.logger.info(`Processing asset mappings for build...`, {
				timestamp: true,
				clear: true
			});

			const assetsDir = resolve(clientDir, assetConfig.assetsSubdir);

			//1. Create initial mappings from output files.
			const assetMappings = createAssetMappings(clientDir, assetsDir, logger);

			//2. Create the Handle any missing assets and update mappings
			const finalMappings = processMissingAssets(clientDir, assetsDir, assetConfig, assetMappings, logger);

			//3. Update HTML files with the final mappings
			logger.info(`Found ${Object.keys(finalMappings).length} total asset mappings:`, { timestamp: true });
			updateHtmlFiles(clientDir, assetConfig, finalMappings, logger);

			logger.info(`Post-build asset processing complete.`, { timestamp: true });
		}
	};
};


export type { AssetConfig };
export { PostBuildAssetsProcessorPlugin };
