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

/**
 * Maps URL route paths to their corresponding HTML file metadata.
 */
interface HtmlFileMap {
  [routePath: string]: {
    filePath: string;
    routeKey: string;
  }
}

/**
 * Recursively discovers all HTML files in a directory and maps them to route paths.
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
 * Create a plugin to serve the service worker in development and test environments.
 */
const ServiceWorkerPlugin = (): Plugin => {
  return {
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
            } else {
              logger.warn(`Service worker file not found at ${swPath}`);
            }
          } catch (error) {
            logger.error('Error serving service worker:', {
              error: error instanceof Error ? error : new Error(String(error))
            });
          }
        }
        next();
      });
    }
  };
}

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
      ...(isDev || isTest ? [ServiceWorkerPlugin()] : []),

      cloudflare({
        configPath: resolve(__dirname, 'wrangler.jsonc'),
        inspectorPort: isTest
          ? parseInt(process.env.CLOUDFLARE_INSPECTOR_PORT ?? '0')
          : DEFAULT_PORT
      }),
      PostBuildAssetsProcessorPlugin({ assetConfig, projectRoot })
    ],
    ...(isDev || isTest ? {
      server: {
        fs: { strict: true },
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': `no-store, max-age=${NO_CACHE_MAX_AGE}`,
          'Content-Security-Policy': [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "connect-src 'self' ws:",
            "require-trusted-types-for 'script'",
            "trusted-types default"
          ].join('; '),
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
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
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'strict-origin-when-cross-origin'
        }
      }
    } : {}),
    logLevel: isDev ? 'info' : 'info'
  };

  return config;
});
