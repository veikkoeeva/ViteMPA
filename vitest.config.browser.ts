import type {LogErrorOptions, LogOptions, LogType, Logger } from 'vite';
import type { RollupError } from 'rollup';
import { defineConfig } from 'vitest/config';


class TestLogger implements Logger {
  private _hasWarned = false;
  private static readonly _warnedMessages = new Set<string>();

  //Private readonly getters for prefixes.
  private get infoPrefix(): string { return '[TEST INFO]'; }
  private get warnPrefix(): string { return '[TEST WARN]'; }
  private get errorPrefix(): string { return '[TEST ERROR]'; }

  //Single place allowed to touch stdout.
  private writeRaw(message: string): void {
    /* eslint-disable no-console */
    process.stdout.write(message + '\n');
    /* eslint-enable no-console */
  }

  //Internal pipeline for formatting.
  private logInternal(prefix: string, msg: string, options?: LogOptions | LogErrorOptions): void {
    const ts = options?.timestamp ? `[${new Date().toISOString()}] ` : '';
    this.writeRaw(`${prefix} ${ts}${msg}`);
  }

  //Interface property.
  get hasWarned(): boolean {
    return this._hasWarned;
  }

  info(msg: string, options?: LogOptions): void {
    this.logInternal(this.infoPrefix, msg, options);
  }

  warn(msg: string, _options?: LogOptions): void {
    this._hasWarned = true;
    TestLogger._warnedMessages.add(msg);
    this.logInternal(this.warnPrefix, msg);
  }

  warnOnce(msg: string, options?: LogOptions): void {
    if (!TestLogger._warnedMessages.has(msg)) {
      this.warn(msg, options);
    }
  }

  error(msg: string, options?: LogErrorOptions): void {
    this.logInternal(this.errorPrefix, msg, options);
    const stack = options?.error && (options.error as Error).stack;
    if (stack) {
      this.logInternal(this.errorPrefix, stack, options);
    }
  }

  clearScreen(_type: LogType): void {
    /* eslint-disable no-console */
    console.clear();
    /* eslint-enable no-console */
  }

  hasErrorLogged(_error: Error | RollupError): boolean {
    return false;
  }
}

export default defineConfig({
  customLogger: new TestLogger(),
  logLevel: 'info',
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage-reports'
    },
    environment: 'node',
    globalSetup: './test/browser-global-setup.ts',
    globals: false,
    include: ['./test/browser-tests.ts'],
    onConsoleLog(log: string): boolean {
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
