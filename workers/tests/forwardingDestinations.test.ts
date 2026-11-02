// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { getDestinationStatuses, registerDestination } from "../forwarding";

type Address = { email: string; verified: string | null };

function page(result: Address[], totalCount: number) {
	return Response.json({ success: true, result, result_info: { page: 1, per_page: 50, count: result.length, total_count: totalCount } });
}

/** Records every request. Cloudflare's live response has total_count but no total_pages. */
function fakeApi(handler: (url: URL, init?: RequestInit) => Response) {
	const calls: { url: URL; init?: RequestInit }[] = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input.toString());
		calls.push({ url, init });
		return handler(url, init);
	}) as typeof fetch;
	return { calls, config: { token: "test-token", accountId: "acct", fetcher } };
}

describe("getDestinationStatuses", () => {
	it("returns null without calling Cloudflare when no token is configured", async () => {
		const { calls, config } = fakeApi(() => page([], 0));
		expect(await getDestinationStatuses({ ...config, token: undefined })).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("reads every page and maps verified and pending addresses", async () => {
		const firstPage = Array.from({ length: 50 }, (_, i) => ({ email: `a${i}@example.com`, verified: "2026-01-01T00:00:00Z" }));
		const { calls, config } = fakeApi((url) =>
			url.searchParams.get("page") === "1" ? page(firstPage, 51) : page([{ email: "Pending@Example.com", verified: null }], 51),
		);
		const statuses = await getDestinationStatuses(config);
		expect(calls).toHaveLength(2);
		expect(calls[0].url.pathname).toBe("/client/v4/accounts/acct/email/routing/addresses");
		expect(calls[0].url.searchParams.get("per_page")).toBe("50");
		expect(statuses?.get("a0@example.com")).toBe("verified");
		expect(statuses?.get("pending@example.com")).toBe("pending");
	});

	it("returns null when Cloudflare rejects the token", async () => {
		const { config } = fakeApi(() => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }));
		expect(await getDestinationStatuses(config)).toBeNull();
	});

	it("returns null when the request itself fails", async () => {
		const fetcher = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		expect(await getDestinationStatuses({ token: "t", accountId: "a", fetcher })).toBeNull();
	});
});

describe("registerDestination", () => {
	it("does not create an address that already exists", async () => {
		const { calls, config } = fakeApi(() => page([{ email: "me@example.com", verified: "2026-01-01T00:00:00Z" }], 1));
		expect(await registerDestination(config, "me@example.com")).toBe("verified");
		expect(calls.every((c) => (c.init?.method ?? "GET") === "GET")).toBe(true);
	});

	it("creates a new address and reports it pending", async () => {
		const { calls, config } = fakeApi((_url, init) =>
			init?.method === "POST"
				? Response.json({ success: true, result: { email: "new@example.com", verified: null } })
				: page([], 0),
		);
		expect(await registerDestination(config, "new@example.com")).toBe("pending");
		const post = calls.find((c) => c.init?.method === "POST");
		expect(JSON.parse(String(post?.init?.body))).toEqual({ email: "new@example.com" });
		expect(new Headers(post?.init?.headers).get("Authorization")).toBe("Bearer test-token");
	});

	it("reports unknown when creating the address fails", async () => {
		const { config } = fakeApi((_url, init) =>
			init?.method === "POST" ? Response.json({ success: false }, { status: 403 }) : page([], 0),
		);
		expect(await registerDestination(config, "new@example.com")).toBe("unknown");
	});

	it("reports unknown when no token is configured", async () => {
		const { config } = fakeApi(() => page([], 0));
		expect(await registerDestination({ ...config, token: undefined }, "new@example.com")).toBe("unknown");
	});
});
