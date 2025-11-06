import { type AssetConfig, PostBuildAssetsProcessorPlugin } from './post-build-assets-processor-plugin.ts';
import { type UserConfig, type Plugin, defineConfig } from 'vite';
import { relative, resolve } from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import fs from 'node:fs';

const projectRoot = resolve(__dirname);
const assetConfig: AssetConfig = {
  srcDir: 'src',
  outputDir: 'dist',
  assetsSubdir: 'assets',
  siteBaseUrl: 'https://test.com'
};

type HtmlFileMap = Record<string, { filePath: string; routeKey: string; }>;

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


const ServiceWorkerPlugin = (): Plugin => ({
  name: 'vite-plugin-service-worker',
  apply: 'serve',
  configureServer(server) {
    const logger = server.config.logger;

    server.middlewares.use((req, res, next) => {
      if (req.url === '/service-worker.js') {
        try {
          const swPath = resolve(projectRoot, 'compiled-sw/service-worker.js');

          if (fs.existsSync(swPath)) {
            logger.info('Serving service-worker.js from compiled-sw directory');
            res.setHeader('Content-Type', 'application/javascript');
            res.end(fs.readFileSync(swPath, 'utf-8'));
            return;
          }

          logger.warn(`Service worker file not found at ${swPath}`);
        } catch (error) {
          logger.error('Error serving service worker:', {
            error: error instanceof Error ? error : new Error(String(error))
          });
        }
      }

      next();
    });
  }
});


export default defineConfig(({ mode }) => {
  const DEFAULT_PORT = 9229;
  const NO_CACHE_MAX_AGE = 0;
  const isDev = mode === 'development';
  const isTest = mode === 'test';
  const isBuild = mode === 'production';

  const htmlFiles = getHtmlFiles('src', resolve(projectRoot, 'src'));

  // Convert to Rollup input format
  const rollupInput = Object.fromEntries(
    Object.entries(htmlFiles).map(([routeKey, { filePath }]) => [routeKey, filePath])
  );

  const config: UserConfig = {
    root: assetConfig.srcDir,
    publicDir: '../public',
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
          'service-worker': resolve(projectRoot, 'compiled-sw/service-worker.js')
        },
        output: {
          entryFileNames: (chunkInfo) => chunkInfo.name === 'service-worker' ? 'service-worker.js' : `${assetConfig.assetsSubdir}/[name]-[hash].js`,
          chunkFileNames: `${assetConfig.assetsSubdir}/[name]-[hash].js`,
          assetFileNames: `${assetConfig.assetsSubdir}/[name]-[hash][extname]`
        }
      }
    },
    css: {
      devSourcemap: true
    },
    plugins: [
      ...(isDev || isTest ? [ServiceWorkerPlugin()] : []),

      // Configure Cloudflare plugin only for worker builds, not for static MPA
      ...(process.env.CLOUDFLARE_BUILD === 'true' ? [
        cloudflare({
          configPath: resolve(__dirname, 'wrangler.jsonc'),
          inspectorPort: isTest
            ? parseInt(process.env.CLOUDFLARE_INSPECTOR_PORT ?? '0')
            : DEFAULT_PORT
        })
      ] : []),

      PostBuildAssetsProcessorPlugin({ assetConfig, projectRoot })
    ],
    ...(isDev || isTest ? {
      server: {
        fs: { strict: true },
        headers: {
					//Access-Control-Allow-Origin allows all localhost origins for development. In production this should be a fixed origin such as https://example.com. Using '*' is broader and allows any domain, so restricting to localhost is slightly safer for development.
					'Access-Control-Allow-Origin': 'http://localhost:*',

					//Disable caching in development. In production you would typically use long-lived immutable caching with hashed filenames.
					'Cache-Control': 'no-store, max-age=0',

					//Strict CSP suitable for production and development. Allows only same-origin scripts, styles, images, fonts, manifest, service worker, and fetch calls.
					'Content-Security-Policy': [
						"default-src 'none'",
						"script-src 'self'",
						"style-src 'self'",
						"img-src 'self' data:",
						"font-src 'self' data:",
						"manifest-src 'self'",
						"worker-src 'self'",
						"connect-src 'self'",
						"base-uri 'self'",
						"form-action 'self'",
						"frame-ancestors 'none'",
						"object-src 'none'",
						"require-trusted-types-for 'script'",
						"trusted-types default",

						//Allows WebSocket connections required by Vite HMR.
						"connect-src 'self' ws:",

						//Allows service workers or modules loaded as blob URLs by Vite.
						"worker-src 'self' blob:",

						//Allows inline styles used by Vite error overlay.
						"style-src 'self' 'unsafe-inline'",

						//Allows 'eval' used by Vite source maps and stack traces.
						"script-src 'self' 'unsafe-eval'"
					].join('; '),

					//Prevents the page from being opened by or interacting with cross-origin windows.
					'Cross-Origin-Opener-Policy': 'same-origin',

					//Requires cross-origin resources to explicitly grant permission for embedding.
					'Cross-Origin-Embedder-Policy': 'require-corp',

					//Prevents other origins from loading this resource unless explicitly allowed.
					'Cross-Origin-Resource-Policy': 'same-origin',

					//Disables optional browser features by default. Same policy would apply in production.
					'Permissions-Policy': [
						'accelerometer=()',
						'camera=()',
						'geolocation=()',
						'gyroscope=()',
						'magnetometer=()',
						'microphone=()',
						'usb=()',
						'fullscreen=(self)'
					].join(', '),

					//Prevents MIME sniffing.
					'X-Content-Type-Options': 'nosniff',

					//Disallows embedding the page in frames.
					'X-Frame-Options': 'DENY',

					//Only send the origin as referrer for cross-origin requests.
					'Referrer-Policy': 'strict-origin-when-cross-origin'
				}
      }
    } : {}),
    logLevel: isDev ? 'info' : 'info'
  };

  return config;
});
