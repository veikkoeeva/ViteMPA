import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersProject(() => {
	return {
		test: {
			coverage: {
				provider: 'v8',
				reporter: ['text', 'json', 'html'],
				reportsDirectory: './coverage-reports'
			},
			globals: true,
			include: ["./test/route-tests.ts"],
			poolOptions: {
				workers: { wrangler: { configPath: './wrangler.toml' } },
			}
		}
	}
});
