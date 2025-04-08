import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config'
import { resolve } from 'node:path';

export default defineWorkersProject(() => {
	return {
		test: {
			coverage: {
				provider: 'v8',
				reporter: ['text', 'json', 'html'],
				reportsDirectory: './coverage-reports'
			},
			globals: false,
			include: ["./test/route-tests.ts" ],
			poolOptions: {
				workers: { wrangler: { configPath: resolve(__dirname, 'wrangler.jsonc') } },
			}
		}
	}
});
