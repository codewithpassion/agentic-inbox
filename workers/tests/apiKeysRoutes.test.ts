// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "../apiKeys/store";
import { fetchApi, getApiKeyStore } from "./helpers";

const getStore = getApiKeyStore;

/** Create a key directly in the store and return the plaintext. */
async function seedKey(name = "seeded") {
	const secret = generateApiKey();
	const record = await getStore().create({
		name,
		keyHash: await hashApiKey(secret),
		keyPrefix: secret.slice(0, 12),
	});
	return { secret, record };
}

function authed(secret: string): RequestInit {
	return { headers: { Authorization: `Bearer ${secret}` } };
}

describe("GET /api/v1/me", () => {
	it("returns the dev principal in tests", async () => {
		const response = await fetchApi("/api/v1/me");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ principal: { kind: "dev" } });
	});

	it("returns the api_key principal with its scope", async () => {
		const { secret, record } = await seedKey("me-key");
		await getStore().update(record.id, { mailboxes: ["a@example.com"] });
		const response = await fetchApi("/api/v1/me", authed(secret));
		expect(await response.json()).toEqual({
			principal: {
				kind: "api_key",
				keyId: record.id,
				name: "me-key",
				mailboxes: ["a@example.com"],
				keyPrefix: secret.slice(0, 12),
			},
		});
	});
});

describe("API key management routes", () => {
	it("rejects every management route for an api_key principal", async () => {
		const { secret } = await seedKey("attacker");
		const id = crypto.randomUUID();

		const list = await fetchApi("/api/v1/api-keys", authed(secret));
		expect(list.status).toBe(403);

		const create = await fetchApi("/api/v1/api-keys", {
			method: "POST",
			...authed(secret),
			headers: { ...authed(secret).headers, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "nope" }),
		});
		expect(create.status).toBe(403);

		const patch = await fetchApi(`/api/v1/api-keys/${id}`, {
			method: "PATCH",
			headers: { ...authed(secret).headers, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "nope" }),
		});
		expect(patch.status).toBe(403);

		const revoke = await fetchApi(`/api/v1/api-keys/${id}/revoke`, { method: "POST", ...authed(secret) });
		expect(revoke.status).toBe(403);

		const del = await fetchApi(`/api/v1/api-keys/${id}`, { method: "DELETE", ...authed(secret) });
		expect(del.status).toBe(403);
	});

	it("creates a key and returns the plaintext exactly once", async () => {
		const response = await fetchApi("/api/v1/api-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "cli", mailboxes: ["a@example.com"] }),
		});
		expect(response.status).toBe(201);
		const { key, secret } = (await response.json()) as { key: Record<string, unknown>; secret: string };
		expect(secret).toMatch(/^aik_[A-Za-z0-9_-]{43}$/);
		expect(key.key_prefix).toBe(secret.slice(0, 12));
		expect(key.key_hash).toBeUndefined();
		expect(key.mailboxes).toEqual(["a@example.com"]);
		expect(key.revoked_at).toBeNull();
	});

	it("rejects invalid create bodies", async () => {
		const response = await fetchApi("/api/v1/api-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ expires_at: "not-a-date" }),
		});
		expect(response.status).toBe(400);
	});

	it("lists keys without hashes", async () => {
		const { record } = await seedKey("listed");
		const response = await fetchApi("/api/v1/api-keys");
		expect(response.status).toBe(200);
		const { keys } = (await response.json()) as { keys: Record<string, unknown>[] };
		const key = keys.find((k) => k.id === record.id);
		expect(key).toBeDefined();
		expect(key!.key_hash).toBeUndefined();
		expect(key!.name).toBe("listed");
	});

	it("patches name, expiry, and mailbox scope", async () => {
		const { record } = await seedKey("patchable");
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
		const response = await fetchApi(`/api/v1/api-keys/${record.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "patched", expires_at: expiresAt, mailboxes: ["b@example.com"] }),
		});
		expect(response.status).toBe(200);
		const { key } = (await response.json()) as { key: Record<string, unknown>; };
		expect(key.name).toBe("patched");
		expect(key.expires_at).toBe(expiresAt);
		expect(key.mailboxes).toEqual(["b@example.com"]);

		const missing = await fetchApi(`/api/v1/api-keys/${crypto.randomUUID()}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
		expect(missing.status).toBe(404);
	});

	it("revokes, which stops verification but keeps the record", async () => {
		const { secret, record } = await seedKey("revocable");
		const response = await fetchApi(`/api/v1/api-keys/${record.id}/revoke`, { method: "POST" });
		expect(response.status).toBe(200);
		const { key } = (await response.json()) as { key: Record<string, unknown>; };
		expect(key.revoked_at).not.toBeNull();

		const after = await fetchApi("/api/v1/config", authed(secret));
		expect(after.status).toBe(401);
	});

	it("deletes, which removes the record", async () => {
		const { secret, record } = await seedKey("deletable");
		const response = await fetchApi(`/api/v1/api-keys/${record.id}`, { method: "DELETE" });
		expect(response.status).toBe(204);

		const after = await fetchApi("/api/v1/config", authed(secret));
		expect(after.status).toBe(401);

		const repeat = await fetchApi(`/api/v1/api-keys/${record.id}`, { method: "DELETE" });
		expect(repeat.status).toBe(404);
	});
});
