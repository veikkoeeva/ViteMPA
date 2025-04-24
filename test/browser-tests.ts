import { beforeAll, describe, expect, test } from 'vitest';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('Browser Tests', () => {
  let baseUrl = '';

  beforeAll(async () => {
      const port = await fs.readFile(path.join(process.cwd(), '.temp', 'vite-port'), 'utf-8');
      baseUrl = `http://localhost:${port}`;
  });

  test('Page contains HTML5 doctype', async () => {
		const browser = await chromium.launch();
		const page = await browser.newPage();

		try {
			await page.goto(baseUrl);

			const doctype = await page.evaluate(() => document.doctype?.name || 'none');
			expect(doctype).toBe('html');

			const htmlTag = await page.evaluate(() => document.documentElement.outerHTML);
			expect(htmlTag).toMatch(/<html[^>]*>/);

			const head = await page.$('head');
			const body = await page.$('body');
			expect(head).toBeTruthy();
			expect(body).toBeTruthy();

		} finally {
			await browser.close();
		}
	});
});
