// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchApi } from "./helpers";

type RuleResponse = { source: string; destination: string; destination_status: string };

function createRule(source: string, destination: string, headers: Record<string, string> = {}) {
	return fetchApi("/api/v1/forwarding", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({ source, destination }),
	});
}

async function listRules() {
	const response = await fetchApi("/api/v1/forwarding");
	expect(response.status).toBe(200);
	return ((await response.json()) as { rules: RuleResponse[] }).rules;
}

describe("/api/v1/forwarding", () => {
	it("creates a rule with lowercased addresses and lists it", async () => {
		const response = await createRule("Create@Mail.Example.com", "Me@Elsewhere.Example");
		expect(response.status).toBe(201);
		const { rule } = (await response.json()) as { rule: RuleResponse };
		expect(rule.source).toBe("create@mail.example.com");
		expect(rule.destination).toBe("me@elsewhere.example");
		expect(rule.destination_status).toBe("unknown");
		expect((await listRules()).map((r) => r.source)).toContain("create@mail.example.com");
	});

	it("rejects a second rule for the same source", async () => {
		await createRule("twice@mail.example.com", "me@elsewhere.example");
		const response = await createRule("TWICE@mail.example.com", "other@elsewhere.example");
		expect(response.status).toBe(409);
	});

	it("rejects a source outside this deployment's domains", async () => {
		const response = await createRule("someone@elsewhere.example", "me@elsewhere.example");
		expect(response.status).toBe(400);
	});

	it("rejects a destination on this deployment's domains, which could loop", async () => {
		const response = await createRule("loop@mail.example.com", "other@MAIL.example.com");
		expect(response.status).toBe(400);
	});

	it("rejects malformed addresses", async () => {
		const response = await createRule("not-an-address", "me@elsewhere.example");
		expect(response.status).toBe(400);
	});

	it("deletes a rule and then reports it missing", async () => {
		await createRule("gone@mail.example.com", "me@elsewhere.example");
		const path = `/api/v1/forwarding/${encodeURIComponent("Gone@mail.example.com")}`;
		expect((await fetchApi(path, { method: "DELETE" })).status).toBe(204);
		expect((await listRules()).map((r) => r.source)).not.toContain("gone@mail.example.com");
		expect((await fetchApi(path, { method: "DELETE" })).status).toBe(404);
	});

	describe("destinations on the account", () => {
		const bindings = env as unknown as Record<string, string | undefined>;

		afterEach(() => {
			vi.restoreAllMocks();
			delete bindings.EMAIL_ROUTING_API_TOKEN;
			delete bindings.EMAIL_ROUTING_ACCOUNT_ID;
		});

		async function listDestinations() {
			const response = await fetchApi("/api/v1/forwarding");
			return ((await response.json()) as { destinations: { email: string; status: string }[] }).destinations;
		}

		it("lists every destination with its status", async () => {
			bindings.EMAIL_ROUTING_API_TOKEN = "test-token";
			bindings.EMAIL_ROUTING_ACCOUNT_ID = "test-account";
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({
					result: [
						{ email: "Done@Elsewhere.Example", verified: "2026-11-02T00:00:00Z" },
						{ email: "waiting@elsewhere.example", verified: null },
					],
					result_info: { total_count: 2 },
				}),
			);
			expect(await listDestinations()).toEqual([
				{ email: "done@elsewhere.example", status: "verified" },
				{ email: "waiting@elsewhere.example", status: "pending" },
			]);
		});

		it("lists none when Cloudflare can't be asked", async () => {
			expect(await listDestinations()).toEqual([]);
		});
	});

	it("refuses API keys, so a leaked key cannot redirect mail", async () => {
		const created = await fetchApi("/api/v1/api-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "forwarding test" }),
		});
		const { secret } = (await created.json()) as { secret: string };
		const auth = { Authorization: `Bearer ${secret}` };

		expect((await fetchApi("/api/v1/forwarding", { headers: auth })).status).toBe(403);
		expect((await createRule("key@mail.example.com", "me@elsewhere.example", auth)).status).toBe(403);
		const path = `/api/v1/forwarding/${encodeURIComponent("key@mail.example.com")}`;
		expect((await fetchApi(path, { method: "DELETE", headers: auth })).status).toBe(403);
	});
});
