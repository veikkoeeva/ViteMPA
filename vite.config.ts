import * as cheerio from 'cheerio';
import { defineConfig, type UserConfig } from 'vite';
import path, { relative, resolve } from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import fs from 'node:fs';
import glob from 'glob';

const projectRoot = resolve(__dirname);

interface AssetConfig {
  srcDir: string;       // Source directory (e.g., 'src')
  outputDir: string;    // Output directory (e.g., "dist")
  assetsSubdir: string; // Subdirectory for assets in output (e.g., 'assets')
  siteBaseUrl: string;  // Base URL of the site
}

const assetConfig: AssetConfig = {
  srcDir: 'src',
  outputDir: 'dist',    // Changed from "../dist" to "dist"
  assetsSubdir: 'assets',
  siteBaseUrl: 'https://test.com'
};

/**
 * Recursively scans a directory for HTML files and returns an object mapping
 * entry names (with folder structure preserved) to their file paths.
 */
const getHtmlFiles = (dir: string, root: string): { [key: string]: string } => {
  const files: { [key: string]: string } = {};
  const traverse = (currentDir: string) => {
    for (const file of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = resolve(currentDir, file.name);
      if (file.isDirectory()) {
        traverse(fullPath);
      } else if (file.name.endsWith('.html')) {
        const relPath = relative(root, fullPath);
        const name = relPath.replace(/\.html$/, '');
        files[name] = fullPath;
      }
    }
  };
  traverse(dir);
  return files;
};

/**
 * Scans HTML files to find asset references that might not be directly imported.
 */
const findUnreferencedAssets = (srcDir: string, baseUrl: string): { [key: string]: string } => {
  const entries: { [key: string]: string } = {};
  const processedAssets = new Set<string>();
  const htmlFiles = glob.sync(`${srcDir}/**/*.html`);

  htmlFiles.forEach(htmlFile => {
    const content = fs.readFileSync(htmlFile, 'utf-8');
    const $ = cheerio.load(content);

    // Look in meta tags
    $('meta[property^="og:image"], meta[name^="twitter:image"]').each((i, el) => {
      const contentAttr = $(el).attr('content');
      if (contentAttr && (contentAttr.includes(baseUrl) || contentAttr.startsWith('/'))) {
        extractAssetPath(contentAttr, baseUrl, srcDir, entries, processedAssets);
      }
    });

    // Look in JSON‑LD
    $('script[type="application/ld+json"]').each((i, el) => {
      const scriptContent = $(el).html();
      if (scriptContent) {
        try {
          const jsonContent = JSON.parse(scriptContent);
          extractAssetsFromJson(jsonContent, baseUrl, srcDir, entries, processedAssets);
        } catch (e) {
          const urlMatches = scriptContent.match(/(https?:\/\/[^"']+\.(jpg|jpeg|png|svg|gif|webp|avif))/g);
          if (urlMatches) {
            urlMatches.forEach(url => {
              if (url.includes(baseUrl)) {
                extractAssetPath(url, baseUrl, srcDir, entries, processedAssets);
              }
            });
          }
        }
      }
    });

    // Look in <img> tags
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      if (src && (src.includes(baseUrl) || src.startsWith('/'))) {
        extractAssetPath(src, baseUrl, srcDir, entries, processedAssets);
      }
    });
  });

  console.log('Found unreferenced assets:', entries);
  return entries;
};

const extractAssetsFromJson = (
  obj: any,
  baseUrl: string,
  srcDir: string,
  entries: { [key: string]: string },
  processedAssets: Set<string>
) => {
  if (!obj || typeof obj !== 'object') return;
  Object.keys(obj).forEach(key => {
    if (typeof obj[key] === 'string') {
      const value = obj[key];
      if ((value.includes(baseUrl) || value.startsWith('/')) &&
          /\.(jpg|jpeg|png|svg|gif|webp|avif)$/.test(value)) {
        extractAssetPath(value, baseUrl, srcDir, entries, processedAssets);
      }
    } else if (Array.isArray(obj[key])) {
      obj[key].forEach((item: any) =>
        extractAssetsFromJson(item, baseUrl, srcDir, entries, processedAssets)
      );
    } else if (typeof obj[key] === 'object') {
      extractAssetsFromJson(obj[key], baseUrl, srcDir, entries, processedAssets);
    }
  });
};

const extractAssetPath = (
  url: string,
  baseUrl: string,
  srcDir: string,
  entries: { [key: string]: string },
  processedAssets: Set<string>
) => {
  // Remove baseUrl (if present) and any leading slash to get the relative path
  let assetPath = url.replace(baseUrl, '').replace(/^\/+/, '');
  const fullSrcPath = path.join(srcDir, assetPath);
  if (fs.existsSync(fullSrcPath)) {
    entries[fullSrcPath] = fullSrcPath;
    processedAssets.add(assetPath);
    console.log(`Asset found: ${assetPath} -> ${fullSrcPath}`);
  } else {
    console.warn(`Asset not found in src: ${fullSrcPath}`);
  }
};

/**
 * Create a mapping of original asset paths (relative to baseDir) to their hashed versions.
 *
 * For example, if an asset file is at:
 *   C:\projektit\ViteMPA\dist\client\assets\images\facebook-banner-example-BIbEEG8u.jpg
 * and baseDir is:
 *   C:\projektit\ViteMPA\dist\client
 * then the relative path becomes:
 *   assets/images/facebook-banner-example-BIbEEG8u.jpg
 * From that we remove the hash to yield:
 *   images/facebook-banner-example.jpg
 * which maps to "assets/images/facebook-banner-example-BIbEEG8u.jpg".
 */
function createAssetMappings(baseDir: string, assetsDir: string): Record<string, string> {
  const assetMappings: Record<string, string> = {};
  const assetFiles = glob.sync(`${assetsDir}/**/*.*`);
  assetFiles.forEach(assetFile => {
    // Compute the path relative to baseDir
    let relativePath = path.relative(baseDir, assetFile).replace(/\\/g, '/');
    const fileName = path.basename(assetFile);
    if (!fileName.match(/-[a-zA-Z0-9_]+\.[a-z]+$/)) return;
    const originalName = fileName.replace(/-[a-zA-Z0-9_]+(\.[a-z]+)$/, '$1');
    const dirRelative = path.dirname(path.relative(assetsDir, assetFile)).replace(/\\/g, '/');
    const originalPath = dirRelative === '.' ? originalName : `${dirRelative}/${originalName}`;
    assetMappings[originalPath] = relativePath;
    console.log(`Mapping created: ${originalPath} -> ${relativePath}`);
  });
  console.log('Final asset mappings:', assetMappings);
  return assetMappings;
}

/**
 * Given a URL, extract its relative asset path (by stripping baseUrl and leading slashes),
 * then look up that path in assetMappings. If found, return the URL rebuilt with the hashed path.
 */
function updateUrl(url: string, assetMappings: Record<string, string>): string {
  const isAbsolute = url.startsWith(assetConfig.siteBaseUrl);
  let assetPath = url;
  if (isAbsolute) {
    assetPath = url.slice(assetConfig.siteBaseUrl.length);
  }
  assetPath = assetPath.replace(/^\/+/, '');
  if (assetMappings[assetPath]) {
    const hashedPath = assetMappings[assetPath];
    const updated = isAbsolute ? `${assetConfig.siteBaseUrl}/${hashedPath}` : `/${hashedPath}`;
    console.log(`Updating URL: "${url}" -> "${updated}" (assetPath: "${assetPath}")`);
    return updated;
  } else {
    console.warn(`No mapping found for URL: "${url}" (extracted assetPath: "${assetPath}")`);
    return url;
  }
}

/**
 * Update all asset URLs in HTML files under baseDir.
 */
function updateHtmlFiles(baseDir: string, assetMappings: Record<string, string>): void {
  const htmlFiles = glob.sync(`${baseDir}/**/*.html`);
  htmlFiles.forEach(htmlFile => {
    console.log(`Processing HTML file: ${htmlFile}`);
    const content = fs.readFileSync(htmlFile, 'utf-8');
    const $ = cheerio.load(content);
    $('[src],[href],[content]').each((i, el) => {
      const $el = $(el);
      ['src', 'href', 'content'].forEach(attr => {
        const value = $el.attr(attr);
        if (value) {
          const updated = updateUrl(value, assetMappings);
          if (updated !== value) {
            console.log(`Updated ${attr}: "${value}" -> "${updated}"`);
          }
          $el.attr(attr, updated);
        }
      });
    });
    $('script[type="application/ld+json"]').each((i, el) => {
      const script = $(el);
      let scriptContent = script.html() || '';
      try {
        const jsonContent = JSON.parse(scriptContent);
        const processJsonUrls = (obj: any) => {
          if (!obj || typeof obj !== 'object') return;
          Object.keys(obj).forEach(key => {
            if (typeof obj[key] === 'string') {
              obj[key] = updateUrl(obj[key], assetMappings);
            } else if (Array.isArray(obj[key])) {
              obj[key].forEach((item: any, index: number) => {
                if (typeof item === 'string') {
                  obj[key][index] = updateUrl(item, assetMappings);
                } else {
                  processJsonUrls(item);
                }
              });
            } else if (typeof obj[key] === 'object') {
              processJsonUrls(obj[key]);
            }
          });
        };
        processJsonUrls(jsonContent);
        const updatedJson = JSON.stringify(jsonContent, null, 2);
        console.log(`Updated JSON‑LD in ${htmlFile}: ${updatedJson}`);
        script.html(updatedJson);
      } catch (e) {
        console.warn(`Error processing JSON‑LD in ${htmlFile}: ${e}`);
        const updated = updateUrl(scriptContent, assetMappings);
        script.html(updated);
      }
    });
    fs.writeFileSync(htmlFile, $.html());
  });
}

/**
 * Plugin to update asset URLs after the build.
 *
 * This version forces the base directory to the client folder.
 */
function postBuildAssetsPlugin(): Plugin {
  return {
    name: 'post-build-assets',
    apply: 'build',
    closeBundle() {
      const distDir = resolve(projectRoot, assetConfig.outputDir);
      const clientDir = resolve(distDir, 'client');
      if (!fs.existsSync(clientDir)) {
        console.error(`Client directory not found at ${clientDir}`);
        return;
      }
      const baseDir = clientDir;
      console.log(`Using client directory for asset processing: ${baseDir}`);
      const assetsDir = resolve(baseDir, assetConfig.assetsSubdir);
      console.log(`Processing assets in: ${baseDir}`);
      const assetMappings = createAssetMappings(baseDir, assetsDir);
      updateHtmlFiles(baseDir, assetMappings);
    },
  };
}


export default defineConfig(({ mode }) => {
	// Port & cache configuration
	const DEFAULT_PORT = 5173;
	const NO_CACHE_MAX_AGE = 0;
	const isDev = mode === 'development';
	const isTest = mode === 'test';

	// Helper to determine assets path depth
	const getAssetsDepth = (filePath: string): number => {
		const normalized = path.normalize(filePath).replace(/\\/g, '/');
		return normalized.startsWith('src/') ? 'src/'.length : 0;
	};

	const config: UserConfig = {
		root: assetConfig.srcDir,
		publicDir: 'public',
		build: {
			assetsInlineLimit: 0,
			emptyOutDir: true,
			outDir: '../dist',
			rollupOptions: {
				input: {
					...findUnreferencedAssets('src', assetConfig.siteBaseUrl),
					...getHtmlFiles('src', resolve(projectRoot, 'src'))
				},
				output: {
					entryFileNames: (chunkInfo) => {
						const noHashFiles = ['background', 'content'];
						return noHashFiles.includes(chunkInfo.name)
							? '[name].js'
							: 'assets/[name]-[hash].js';
					},
					chunkFileNames: 'assets/[name]-[hash].js',
					assetFileNames: (assetInfo) => {
						if (assetInfo.originalFileNames && assetInfo.originalFileNames.length > 0) {
							let originalFile = assetInfo.originalFileNames[0];
							if (/\.(png|jpe?g|gif|svg|webp)$/i.test(originalFile)) {
								if (originalFile.startsWith('src/')) {
									originalFile = originalFile.slice(4); // remove 'src/' prefix
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
				configPath: '../wrangler.toml',
				inspectorPort: isTest
					? parseInt(process.env.CLOUDFLARE_INSPECTOR_PORT ?? '0')
					: DEFAULT_PORT
			}),
			{
				configResolved(config) {
					Object.values(config.build.rollupOptions?.input || {}).forEach((file: string) => {
						if (!fs.existsSync(file)) {
							console.error(`Input file not found: ${file}`);
							// Optionally, throw an error:
							// throw new Error(`Input file not found: ${file}`);
						}
					});
				},
				name: 'asset-path-validator'
			},
			postBuildAssetsPlugin()
		],
		...(isDev && {
			server: {
				fs: { strict: false },
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Cache-Control': `no-store, max-age=${NO_CACHE_MAX_AGE}`
				}
			}
		})
	};

	return config;
});
