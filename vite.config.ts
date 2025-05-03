import { type AssetConfig, PostBuildAssetsProcessorPlugin } from './post-build-assets-processor-plugin.ts';
import { type UserConfig, defineConfig } from 'vite';
import { relative, resolve } from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import fs from 'node:fs';


const projectRoot = resolve(__dirname);
const assetConfig: AssetConfig = {
	srcDir: 'src',
	outputDir: 'dist',

	/** Directory where Vite stores assets in <outputDir>. */
	assetsSubdir: 'assets',

	/** This is the expected site base URL against which
	 * assets such as meta tags and JSON-LD is tested.
	 */
	siteBaseUrl: 'https://test.com'
};


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
		 * Filesystem (non absolute) path to the HTML file.
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
					...rollupInput,
					'service-worker': resolve(projectRoot, 'public/service-worker.js')
				},
				output: {
					entryFileNames: (chunkInfo) => {
						//While the service-worker.js is optimized, its filename
						//should be kept as-is.
						return chunkInfo.name === 'service-worker'
							? 'service-worker.js'
							: `${assetConfig.assetsSubdir}/[name]-[hash].js`;
					},
					chunkFileNames: `${assetConfig.assetsSubdir}/[name]-[hash].js`,
					assetFileNames: `${assetConfig.assetsSubdir}/[name]-[hash][extname]`
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
			PostBuildAssetsProcessorPlugin( { assetConfig, projectRoot })
		],
		...(isDev && {
			server: {
				fs: { strict: true },
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Cache-Control': `no-store, max-age=${NO_CACHE_MAX_AGE}`
				}
			}
		}),
		logLevel: isDev ? 'info' : 'info'
	};

	return config;
});
