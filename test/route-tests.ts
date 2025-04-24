import {
	SELF,
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createIncomingRequest } from "./incoming-request";
import worker from "../cloudflare";



describe("Main page tests", () => {
	it('responds with HTML that starts with a doctype', async () => {

		const request = createIncomingRequest("http://test.com/index.html");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		const html = await response.text();
		expect(html).toMatch(/^\s*<!doctype html>/i);
	});

	it("responds with not found and proper status for /404", async () => {
		const request = createIncomingRequest("http://example.com/404");

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		const HttpNotFound = 404;
		expect(response.status).toBe(HttpNotFound);
		expect(await response.text()).toBe("Asset not found. Check the URL or try again later.");
	});
});

describe("Integration test style", async () => {
	it('responds with "Hello, World!" (integration style)', async () => {
		const response = await SELF.fetch("http://example.com/index.html");

		const html = await response.text();
		expect(html).toMatch(/^\s*<!doctype html>/i);
	});
});
