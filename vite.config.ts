import * as cheerio from 'cheerio';
import type { Plugin, UserConfig } from 'vite';
import path, { relative, resolve } from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import fs from 'node:fs';
import glob from 'glob';


/**
 * Recursively scans a directory for HTML files and returns an object mapping
 * entry names to their file paths.
 *
 * @param dir - Directory to scan for HTML files
 * @param root - Root directory for calculating relative paths
 * @returns Object mapping entry names (without .html extension) to file paths
 */
const getHtmlFiles = (dir: string, root: string): { [key: string]: string } => {
	const files: { [key: string]: string } = {};

	const traverse = (currentDir: string) => {
		for (const file of fs.readdirSync(currentDir, { withFileTypes: true })) {
			const fullPath = resolve(currentDir, file.name);
			if (file.isDirectory()) {
				traverse(fullPath);
			} else if (file.name.endsWith('.html')) {
				const relativePath = relative(root, fullPath);
				const name = relativePath.replace(/\.html$/, '');
				files[name] = fullPath;
			}
		}
	};

	traverse(dir);
	return files;
};

interface AssetConfig {
	srcDir: string; // Source directory for assets, e.g., 'src'
	outputDir: string; // Output directory, e.g., 'dist'
	assetsSubdir: string; // Subdirectory for assets in output, e.g., 'assets'
	siteBaseUrl: string; // Base URL of the site, e.g., 'https://test.com'
}

/**
 * Configuration for asset processing
 */
const assetConfig: AssetConfig = {
	assetsSubdir: 'assets',
	outputDir: 'dist',
	siteBaseUrl: 'https://test.com',
	srcDir: 'src'
};


/**
 * Scans HTML files to find asset references that need to be processed by Vite
 * but might not be directly imported in JavaScript or CSS.
 *
 * @param srcDir - Directory containing HTML files to scan
 * @param baseUrl - Base URL to detect in asset references
 * @returns Object mapping entry paths to their file paths for Rollup
 */
/**
 * Scans HTML files to find asset references that need to be processed by Vite
 * but might not be directly imported in JavaScript or CSS.
 *
 * @param srcDir - Directory containing HTML files to scan
 * @param baseUrl - Base URL to detect in asset references
 * @returns Object mapping entry paths to their file paths for Rollup
 */
const findUnreferencedAssets = (srcDir: string, baseUrl: string): { [key: string]: string } => {
  const entries: { [key: string]: string } = {};
  const htmlFiles = glob.sync(`${srcDir}/**/*.html`);
  const processedAssets = new Set<string>();

  htmlFiles.forEach(htmlFile => {
    const content = fs.readFileSync(htmlFile, 'utf-8');
    const $ = cheerio.load(content);

    // Check meta tags with images
    $('meta[property^="og:image"], meta[name^="twitter:image"]').each((i, el) => {
      const contentAttr = $(el).attr('content');
      if (contentAttr && (contentAttr.includes(baseUrl) || contentAttr.startsWith('/'))) {
        extractAssetPath(contentAttr, baseUrl, srcDir, entries, processedAssets);
      }
    });

    // Check JSON-LD scripts
    $('script[type="application/ld+json"]').each((i, el) => {
      const content = $(el).html();
      if (content) {
        try {
          const jsonContent = JSON.parse(content);
          extractAssetsFromJson(jsonContent, baseUrl, srcDir, entries, processedAssets);
        } catch (e) {
          // If parsing fails, do a simpler string scan
          const urlMatches = content.match(/(https?:\/\/[^"']+\.(jpg|jpeg|png|svg|gif|webp|avif))/g);
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

    // Also check img tags, CSS background images, etc.
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      if (src && (src.includes(baseUrl) || src.startsWith('/'))) {
        extractAssetPath(src, baseUrl, srcDir, entries, processedAssets);
      }
    });
  });

  console.log("Unreferenced assets found:", JSON.stringify(entries, null, 2));
  return entries;
};

/**
 * Recursive function to extract assets from JSON objects
 */
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
      obj[key].forEach(item => extractAssetsFromJson(item, baseUrl, srcDir, entries, processedAssets));
    } else if (typeof obj[key] === 'object') {
      extractAssetsFromJson(obj[key], baseUrl, srcDir, entries, processedAssets);
    }
  });
};

/**
 * Extracts the asset path from a URL and adds it to entries if it exists
 */
const extractAssetPath = (
  url: string,
  baseUrl: string,
  srcDir: string,
  entries: { [key: string]: string },
  processedAssets: Set<string>
) => {
  console.log("Processing URL:", url);

  // Remove the base URL if present
  let assetPath = url.replace(baseUrl, '');
  console.log("After removing base URL:", assetPath);

  // Remove leading slash if present
  assetPath = assetPath.replace(/^\//, '');
  console.log("After removing leading slash:", assetPath);

  // Construct the full path to the asset in the src directory
  const fullSrcPath = path.join(srcDir, assetPath);
  console.log("Full src path:", fullSrcPath);

  // Check if the file exists
  if (fs.existsSync(fullSrcPath)) {
    entries[fullSrcPath] = fullSrcPath;
    processedAssets.add(assetPath);
    console.log(`Found unreferenced asset: ${assetPath} at ${fullSrcPath}`);
  } else {
    console.warn(`Could not find asset referenced in HTML: ${assetPath}`);
  }
};




function postBuildAssetsPlugin(): Plugin {
  return {
    name: 'post-build-assets',
    apply: 'build',
    closeBundle() {
      const projectRoot = process.cwd();
      const distDir = path.resolve(projectRoot, assetConfig.outputDir);
      const assetsDir = path.resolve(distDir, assetConfig.assetsSubdir);

      // We don't need to find unreferenced assets here as we're updating URLs in existing HTML files
      // Instead, we need to create a mapping of original asset paths to their hashed versions
      const assetMappings = createAssetMappings(distDir, assetsDir);

      console.log('Asset Mappings:', JSON.stringify(assetMappings, null, 2));
      updateHtmlFiles(distDir, assetMappings);
    },
  };
}


function createAssetMappings(distDir: string, assetsDir: string): Record<string, string> {
  const assetMappings: Record<string, string> = {};

  // Find all files in the assets directory
  const assetFiles = glob.sync(`${assetsDir}/**/*.*`);

  // Process each file to extract the original path and the hashed filename
  assetFiles.forEach((assetFile) => {
    const relativePath = path.relative(distDir, assetFile);
    // Normalize path separators to forward slashes for URLs
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');
    const fileName = path.basename(assetFile);

    // Skip files that don't have a hash pattern (e.g., they have normal names)
    if (!fileName.match(/-[a-zA-Z0-9_]+\.[a-z]+$/)) {
      return;
    }

    // Extract the original filename by removing the hash
    const originalName = fileName.replace(/-[a-zA-Z0-9_]+(\.[a-z]+)$/, '$1');

    // Get the directory relative to assets
    const dirRelativeToAssets = path.dirname(path.relative(assetsDir, assetFile));
    // Normalize path separators to forward slashes for URLs
    const normalizedDirRelative = dirRelativeToAssets.replace(/\\/g, '/');

    // Create the relative path that would be in a URL (e.g., images/logo.svg)
    let originalPath;
    if (normalizedDirRelative === '.') {
      originalPath = originalName;
    } else {
      originalPath = `${normalizedDirRelative}/${originalName}`;
    }

    // Store the mapping from originalPath to normalizedRelativePath (which includes the hash)
    assetMappings[originalPath] = normalizedRelativePath;

    console.log(`Mapped ${originalPath} to ${normalizedRelativePath}`);
  });

  return assetMappings;
}

/**
 * Scans all HTML files in the dist folder and replaces asset references.
 * @param distDir The output directory (e.g., "dist")
 * @param assetMappings An object mapping original asset paths to their hashed versions
 */
function updateHtmlFiles(distDir: string, assetMappings: Record<string, string>): void {
  const htmlFiles = glob.sync(`${distDir}/**/*.html`);

  htmlFiles.forEach((htmlFile) => {
    let content = fs.readFileSync(htmlFile, 'utf-8');
    const $ = cheerio.load(content);

    console.log(`Processing HTML file: ${htmlFile}`);

    // Process meta tags with og:image, twitter:image, etc.
    $('meta[property^="og:image"], meta[name^="twitter:image"]').each((i, el) => {
      const meta = $(el);
      let contentAttr = meta.attr('content');

      if (contentAttr) {
        console.log(`Found meta tag with content: ${contentAttr}`);

        // For each asset in our mappings
        for (const [originalPath, hashedPath] of Object.entries(assetMappings)) {
          // Check if the content attribute contains this path
          // We need to handle both absolute URLs and relative paths
          const absoluteUrlPattern = new RegExp(`${assetConfig.siteBaseUrl}/${originalPath.replace(/\//g, '[\\\\/]')}`, 'g');
          const relativePathPattern = new RegExp(`^/${originalPath.replace(/\//g, '[\\\\/]')}`, 'g');

          if (contentAttr.match(absoluteUrlPattern)) {
            // Replace the absolute URL with a new one that includes the hashed path
            // Always use forward slashes in URLs
            const newUrl = `${assetConfig.siteBaseUrl}/${hashedPath}`;
            contentAttr = contentAttr.replace(absoluteUrlPattern, newUrl);
            meta.attr('content', contentAttr);
            console.log(`Updated absolute URL in meta tag: ${newUrl}`);
          } else if (contentAttr.match(relativePathPattern)) {
            // Replace the relative path with a new one that includes the hashed path
            // Always use forward slashes in URLs
            const newPath = `/${hashedPath}`;
            contentAttr = contentAttr.replace(relativePathPattern, newPath);
            meta.attr('content', contentAttr);
            console.log(`Updated relative path in meta tag: ${newPath}`);
          }
        }
      }
    });

    // Process img tags
    $('img').each((i, el) => {
      const img = $(el);
      let src = img.attr('src');

      if (src) {
        console.log(`Found img with src: ${src}`);

        // For each asset in our mappings
        for (const [originalPath, hashedPath] of Object.entries(assetMappings)) {
          const absoluteUrlPattern = new RegExp(`${assetConfig.siteBaseUrl}/${originalPath.replace(/\//g, '[\\\\/]')}`, 'g');
          const relativePathPattern = new RegExp(`^/${originalPath.replace(/\//g, '[\\\\/]')}`, 'g');

          if (src.match(absoluteUrlPattern)) {
            const newUrl = `${assetConfig.siteBaseUrl}/${hashedPath}`;
            src = src.replace(absoluteUrlPattern, newUrl);
            img.attr('src', src);
            console.log(`Updated absolute URL in img src: ${newUrl}`);
          } else if (src.match(relativePathPattern)) {
            const newPath = `/${hashedPath}`;
            src = src.replace(relativePathPattern, newPath);
            img.attr('src', src);
            console.log(`Updated relative path in img src: ${newPath}`);
          }
        }
      }
    });

    // Process JSON-LD scripts
    $('script[type="application/ld+json"]').each((i, el) => {
      const script = $(el);
      let jsonContent = null;
      let content = script.html();

      if (content) {
        console.log(`Found JSON-LD script in ${htmlFile}`);
        let modified = false;

        try {
          jsonContent = JSON.parse(content);
          console.log('Parsed JSON-LD content successfully');

          // Recursive function to update URLs in JSON
          const processJsonUrls = (obj: any) => {
            if (!obj || typeof obj !== 'object') return;

            Object.keys(obj).forEach((key) => {
              if (typeof obj[key] === 'string') {
                const value = obj[key];
                console.log(`Checking key "${key}" with value: ${value}`);

                // For each asset in our mappings
                for (const [originalPath, hashedPath] of Object.entries(assetMappings)) {
                  // Use a regex that matches both forward and backslashes
                  const absoluteUrlPattern = new RegExp(`${assetConfig.siteBaseUrl}/${originalPath.replace(/\//g, '[\\\\/]')}`, 'g');
                  const relativePathPattern = new RegExp(`^/${originalPath.replace(/\//g, '[\\\\/]')}`, 'g');

                  if (value.match(absoluteUrlPattern)) {
                    // Always use forward slashes in URLs
                    const newUrl = `${assetConfig.siteBaseUrl}/${hashedPath}`;
                    obj[key] = value.replace(absoluteUrlPattern, newUrl);
                    modified = true;
                    console.log(`Updated absolute URL in JSON-LD: ${newUrl}`);
                  } else if (value.match(relativePathPattern)) {
                    // Always use forward slashes in URLs
                    const newPath = `/${hashedPath}`;
                    obj[key] = value.replace(relativePathPattern, newPath);
                    modified = true;
                    console.log(`Updated relative path in JSON-LD: ${newPath}`);
                  }
                }
              } else if (Array.isArray(obj[key])) {
                obj[key].forEach((item) => processJsonUrls(item));
              } else if (typeof obj[key] === 'object') {
                processJsonUrls(obj[key]);
              }
            });
          };

          // Process the JSON-LD content
          processJsonUrls(jsonContent);

          if (modified) {
            console.log('JSON-LD content modified, updating script');
            // Use a custom stringify that doesn't escape forward slashes
            // and uses forward slashes in paths
            script.html(
              JSON.stringify(jsonContent, null, 2)
                // Convert any remaining backslashes to forward slashes for URLs
                .replace(/\\\\(?=[a-zA-Z0-9_-]+\\\\)/g, '/')
                .replace(/\\\\/g, '/')
            );
          } else {
            console.log('No modifications made to JSON-LD content');
          }
        } catch (e) {
          console.warn(`Error parsing JSON-LD in ${htmlFile}:`, e);

          // Fallback to string replacement if JSON parsing fails
          for (const [originalPath, hashedPath] of Object.entries(assetMappings)) {
            const escapedOriginalPath = originalPath.replace(/\//g, '[\\\\/]');
            const absoluteUrlPattern = new RegExp(`${assetConfig.siteBaseUrl}/${escapedOriginalPath}`, 'g');
            const relativePathPattern = new RegExp(`^/${escapedOriginalPath}`, 'g');

            if (content.match(absoluteUrlPattern)) {
              const newUrl = `${assetConfig.siteBaseUrl}/${hashedPath}`;
              content = content.replace(absoluteUrlPattern, newUrl);
              modified = true;
              console.log(`Updated absolute URL in JSON-LD string: ${newUrl}`);
            } else if (content.match(relativePathPattern)) {
              const newPath = `/${hashedPath}`;
              content = content.replace(relativePathPattern, newPath);
              modified = true;
              console.log(`Updated relative path in JSON-LD string: ${newPath}`);
            }
          }

          if (modified) {
            console.log('JSON-LD string content modified, updating script');
            // Fix path separators for URLs
            content = content.replace(/\\\\(?=[a-zA-Z0-9_-]+\\\\)/g, '/').replace(/\\\\/g, '/');
            script.html(content);
          }
        }
      }
    });

    // Process source tags in picture elements
    $('source').each((i, el) => {
      const source = $(el);
      let srcset = source.attr('srcset');

      if (srcset) {
        console.log(`Found source with srcset: ${srcset}`);

        for (const [originalPath, hashedPath] of Object.entries(assetMappings)) {
          const absoluteUrlPattern = new RegExp(`${assetConfig.siteBaseUrl}/${originalPath.replace(/\//g, '[\\\\/]')}`, 'g');
          const relativePathPattern = new RegExp(`^/${originalPath.replace(/\//g, '[\\\\/]')}`, 'g');

          if (srcset.match(absoluteUrlPattern)) {
            const newUrl = `${assetConfig.siteBaseUrl}/${hashedPath}`;
            srcset = srcset.replace(absoluteUrlPattern, newUrl);
            source.attr('srcset', srcset);
            console.log(`Updated absolute URL in source srcset: ${newUrl}`);
          } else if (srcset.match(relativePathPattern)) {
            const newPath = `/${hashedPath}`;
            srcset = srcset.replace(relativePathPattern, newPath);
            source.attr('srcset', srcset);
            console.log(`Updated relative path in source srcset: ${newPath}`);
          }
        }
      }
    });

    // Process link tags (for favicons, etc.)
    $('link[rel="icon"], link[rel="apple-touch-icon"]').each((i, el) => {
      const link = $(el);
      let href = link.attr('href');

      if (href) {
        console.log(`Found link with href: ${href}`);

        for (const [originalPath, hashedPath] of Object.entries(assetMappings)) {
          const absoluteUrlPattern = new RegExp(`${assetConfig.siteBaseUrl}/${originalPath.replace(/\//g, '[\\\\/]')}`, 'g');
          const relativePathPattern = new RegExp(`^/${originalPath.replace(/\//g, '[\\\\/]')}`, 'g');

          if (href.match(absoluteUrlPattern)) {
            const newUrl = `${assetConfig.siteBaseUrl}/${hashedPath}`;
            href = href.replace(absoluteUrlPattern, newUrl);
            link.attr('href', href);
            console.log(`Updated absolute URL in link href: ${newUrl}`);
          } else if (href.match(relativePathPattern)) {
            const newPath = `/${hashedPath}`;
            href = href.replace(relativePathPattern, newPath);
            link.attr('href', href);
            console.log(`Updated relative path in link href: ${newPath}`);
          }
        }
      }
    });

    // Write the updated HTML content back to the file
    fs.writeFileSync(htmlFile, $.html());
    console.log(`Updated HTML file: ${htmlFile}`);
  });
}


export default {
	build: {
		outDir: '../dist',
		emptyOutDir: true,
		rollupOptions: {
			input: {
				// all the HTML files:
				...getHtmlFiles('src', resolve(__dirname, 'src')),
				...findUnreferencedAssets('src', assetConfig.siteBaseUrl)
				// Add external asset entries that need to be processed by Vite
				// but aren't directly referenced in HTML/CSS/JS
				//'src/images/facebook-banner-example.jpg': resolve(__dirname, 'src/images/facebook-banner-example.jpg'),
				//'src/images/logo.svg': resolve(__dirname, 'src/images/logo.svg')
			},
			output: {
        entryFileNames: (chunkInfo) => {
          const noHashFiles = ['background', 'content'];
          if (noHashFiles.includes(chunkInfo.name)) {
            return '[name].js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (
            assetInfo.originalFileNames &&
            assetInfo.originalFileNames.length > 0
          ) {
            let originalFile = assetInfo.originalFileNames[0];
            // Only apply this custom naming for image files
            if (/\.(png|jpe?g|gif|svg|webp)$/i.test(originalFile)) {
              console.log(`[Vite Asset] Processed image: ${originalFile}`);
              if (originalFile.startsWith('src/')) {
                originalFile = originalFile.slice('src/'.length);
              }
              // Split filename and extension to insert the hash
              const parts = originalFile.split('.');
							if (parts.length < 2) {
								// Fallback naming if no extension is found
								return `assets/${originalFile}-[hash]`;
							}
							const ext = parts.pop() as string;
							const nameWithoutExt = parts.join('.');
							return `assets/${nameWithoutExt}-[hash].${ext}`;
            } else {
              console.log(`[Vite Asset] Non-image asset, using default naming: ${originalFile}`);
            }
          } else {
            console.log('[Vite Asset] No original file names found. Using fallback naming.');
          }
          return 'assets/[hash][extname]';
        },
      },
		},
		assetsInlineLimit: 0
	},
	css: {
		devSourcemap: true
	},
	plugins: [
		postBuildAssetsPlugin(),
		cloudflare( { configPath: "../wrangler.toml", inspectorPort: 5173 })
	],
	publicDir: 'public',
	root: 'src'
} satisfies UserConfig;
