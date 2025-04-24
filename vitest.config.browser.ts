import { defineConfig } from 'vitest/config';
import type { Logger } from 'vite';

class TestLogger implements Logger {
  private _hasWarned = false;
  private warnedMessages = new Set<string>();

  // Required properties (not methods!)
  get hasWarned(): boolean {
    return this._hasWarned;
  }

  // Methods
  info(msg: string, options?: { timestamp?: boolean }) {
    const ts = options?.timestamp ? `[${new Date().toISOString()}] ` : '';
    console.log(`[TEST INFO] ${ts}${msg}`);
  }

  warn(msg: string) {
    console.warn(`[TEST WARN] ${msg}`);
    this._hasWarned = true;
    this.warnedMessages.add(msg);
  }

  warnOnce(msg: string) {
    if (!this.warnedMessages.has(msg)) {
      this.warn(msg);
    }
  }

  error(msg: string, options?: { error?: Error }) {
    console.error(`[TEST ERROR] ${msg}`);
    if (options?.error) console.error(options.error.stack);
  }

  clearScreen(msg: string) {
    console.clear();
    if (msg) this.info(msg);
  }

  hasErrorLogged(error: Error): boolean {
    return false;
  }
}

// 2. Apply at Vite config level (not test level)
export default defineConfig({
  customLogger: new TestLogger(),
  logLevel: 'info',

  //Vitest-specific configuration
  test: {
    environment: 'node',
    globalSetup: './test/browser-global-setup.ts',
    globals: false,
    include: ['./test/browser-tests.ts'],
		onConsoleLog(log, type) {
      if (log.includes('SENSITIVE')) {
				return false;
			}

      return true;
    },
    pool: 'threads',
    reporters: ['default', 'hanging-process'],
    teardownTimeout: 5000,
    watch: true
  }
});
