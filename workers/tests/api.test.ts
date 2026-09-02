// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../index";
import type { Env } from "../types";

/**
 * Fetch the API sub-app with the test bindings from the vitest pool.
 * Tests run against workers/index.ts directly, so `waitUntil` callbacks
 * (deferred email delivery) are collected but never awaited.
 */
export async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
	const request = new Request(`https://mail.example.com${path}`, init);
	return await app.fetch(request, env as unknown as Env, {
		waitUntil: () => {},
		passThroughOnException: () => {},
	} as unknown as ExecutionContext);
}

describe("GET /api/v1/config", () => {
	it("returns configured domains and allowed email addresses", async () => {
		const response = await fetchApi("/api/v1/config");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			domains: ["mail.example.com"],
			emailAddresses: [],
		});
	});
});
