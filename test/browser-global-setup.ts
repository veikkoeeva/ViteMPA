import type { LogErrorOptions, Logger } from 'vite';
import type { TestProject } from 'vitest/node';
import fs from 'node:fs/promises';
import getPort from 'get-port';
import path from 'node:path';
import { spawn } from 'child_process';
import treeKill from 'tree-kill';
import waitOn from 'wait-on';


const tempDir = path.join(process.cwd(), '.temp');
let viteServer: ReturnType<typeof spawn> | null = null;

class FallbackLogger implements Logger {
  hasWarned = false;
  private warnedMessages = new Set<string>();

  info(msg: string, _options?: { timestamp?: boolean }) {
    console.log(`[INFO] ${msg}`);
  }

  warn(msg: string) {
    this.hasWarned = true;
    console.warn(`[WARN] ${msg}`);
  }

  warnOnce(msg: string) {
    if (!this.warnedMessages.has(msg)) {
      this.warn(msg);
      this.warnedMessages.add(msg);
    }
  }

  error(msg: string, options?: LogErrorOptions & { error?: Error }) {
    console.error(`[ERROR] ${msg}`);
    if (options?.error) {
      console.error(options.error.stack || options.error.message);
    }
  }

  clearScreen(msg: string) {
    console.clear();
    if (msg) this.info(msg);
  }

  hasErrorLogged(_error: Error): boolean {
    return false;
  }
}

export default async function setup(project: TestProject) {
  const logger = (project.options?.customLogger as Logger | undefined) ?? new FallbackLogger();

  try {
    await fs.mkdir(tempDir, { recursive: true });
    logger.info('Creating temp directory');

    const vitePort = await getPort({ port: [6100, 0], exclude: [5173] });
    const cloudflarePort = await getPort({ port: [8787, 0], exclude: [5173, vitePort] });
    logger.info(`Acquired ports - Vite: ${vitePort}, Cloudflare: ${cloudflarePort}`);

    logger.info('Starting Vite server...');
    viteServer = spawn('vite', [
      'preview',
      '--port', String(vitePort),
      '--strictPort',
      '--mode', 'test'
    ], {
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: project.config.watch,
      env: {
        ...process.env,
        VITE_PREVENT_PORT_FALLBACK: 'true',
        CLOUDFLARE_INSPECTOR_PORT: String(cloudflarePort),
        MINIFLARE_INSPECTOR_PORT: String(cloudflarePort)
      }
    });

    viteServer.stdout?.on('data', (data) => logger.info(data.toString().trim()));
    viteServer.stderr?.on('data', (data) => logger.error(data.toString().trim(), { error: new Error('Vite stderr') }));
    viteServer.on('error', (err) => logger.error('Vite server error', { error: err }));

    if (!viteServer.pid) { throw new Error('Vite server failed to launch'); }
    logger.info(`Server running (PID: ${viteServer.pid})`);

    await waitOn({
      resources: [`http://localhost:${vitePort}`],
      timeout: 15000
    });

    await Promise.all([
      fs.writeFile(path.join(tempDir, 'vite-port'), String(vitePort)),
      fs.writeFile(path.join(tempDir, 'cloudflare-port'), String(cloudflarePort))
    ]);

    type ProvidedContext = {
      vitePort: number;
      cloudflarePort: number;
    };

    (project as unknown as { provide<T extends keyof ProvidedContext>(
      key: T,
      value: ProvidedContext[T]
    ): void }).provide('vitePort', vitePort);

    (project as unknown as { provide<T extends keyof ProvidedContext>(
      key: T,
      value: ProvidedContext[T]
    ): void }).provide('cloudflarePort', cloudflarePort);

    return async () => {
      if (project.config.watch) {
        logger.info('Skipping teardown in watch mode');
        return;
      }

      logger.info('Starting teardown...');
      try {
        if (viteServer?.pid) {
          await new Promise<void>((resolve) => {
            treeKill(viteServer!.pid!, 'SIGTERM', (err) => {
              if (err) logger.error('Process kill error', { error: err as Error });
              resolve();
            });
          });
        }

        await Promise.allSettled([
          fs.unlink(path.join(tempDir, 'vite-port')),
          fs.unlink(path.join(tempDir, 'cloudflare-port'))
        ]);
        logger.info('Teardown completed');
      } catch (err) {
        logger.error('Teardown failed', { error: err as Error });
        throw err;
      }
    };
  } catch (err) {
    logger.error('Setup failed', { error: err as Error });
    if (viteServer?.pid) treeKill(viteServer.pid, 'SIGKILL');
    throw err;
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    vitePort: number;
    cloudflarePort: number;
  }
}
