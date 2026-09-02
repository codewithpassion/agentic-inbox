// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	apiKeyDisplayPrefix,
	generateApiKey,
	hashApiKey,
	type ApiKeyRecord,
} from "../apiKeys/store";

function getStore() {
	const ns = env.API_KEYS;
	return ns.get(ns.idFromName("global"));
}

async function createKey(overrides: Partial<Parameters<Awaited<ReturnType<typeof getStore>>["create"]>[0]> = {}) {
	const key = generateApiKey();
	return {
		key,
		record: await getStore().create({
			name: "test key",
			keyHash: await hashApiKey(key),
			keyPrefix: apiKeyDisplayPrefix(key),
			...overrides,
		}),
	};
}

let created: { key: string; record: ApiKeyRecord };
beforeEach(async () => {
	created = await createKey();
});

describe("ApiKeyStore.create", () => {
	it("stores the hash and prefix, never the plaintext", async () => {
		const { record } = created;
		expect(record.key_hash).not.toBe(created.key);
		expect(record.key_hash).toHaveLength(64);
		expect(record.key_prefix).toBe(created.key.slice(0, 12));
		expect(record.name).toBe("test key");
		expect(record.revoked_at).toBeNull();
	});

	it("round-trips an optional mailbox restriction", async () => {
		const { record } = await createKey({ mailboxes: ["a@example.com", "b@example.com"] });
		const fetched = await getStore().get(record.id);
		expect(fetched?.mailboxes).toEqual(["a@example.com", "b@example.com"]);
	});
});

describe("ApiKeyStore.verify", () => {
	it("accepts a valid key and refreshes last_used_at", async () => {
		const verified = await getStore().verify(await hashApiKey(created.key));
		expect(verified).not.toBeNull();
		expect(verified!.id).toBe(created.record.id);
		expect(verified!.last_used_at).not.toBeNull();
	});

	it("rejects an unknown key", async () => {
		const verified = await getStore().verify(await hashApiKey(generateApiKey()));
		expect(verified).toBeNull();
	});

	it("rejects a revoked key", async () => {
		await getStore().revoke(created.record.id);
		const verified = await getStore().verify(await hashApiKey(created.key));
		expect(verified).toBeNull();
	});

	it("rejects an expired key", async () => {
		const { key } = await createKey({
			expiresAt: new Date(Date.now() - 1_000).toISOString(),
		});
		const verified = await getStore().verify(await hashApiKey(key));
		expect(verified).toBeNull();
	});

	it("accepts a key that has not expired yet", async () => {
		const { key } = await createKey({
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		expect(await getStore().verify(await hashApiKey(key))).not.toBeNull();
	});

	it("throttles last_used_at to once per minute", async () => {
		const store = getStore();
		const first = await store.verify(await hashApiKey(created.key));
		const second = await store.verify(await hashApiKey(created.key));
		expect(second!.last_used_at).toBe(first!.last_used_at);
	});
});

describe("ApiKeyStore.revoke / delete / update", () => {
	it("revoke stamps revoked_at once and the record stays listed", async () => {
		const revoked = await getStore().revoke(created.record.id);
		expect(revoked!.revoked_at).not.toBeNull();
		// Revoking twice is a no-op: the original timestamp wins.
		const again = await getStore().revoke(created.record.id);
		expect(again!.revoked_at).toBe(revoked!.revoked_at);
		// Storage persists between tests in a file, so assert on this key only.
		const listed = (await getStore().list()).find((k) => k.id === created.record.id);
		expect(listed?.revoked_at).toBe(revoked!.revoked_at);
	});

	it("delete removes the record", async () => {
		expect(await getStore().delete(created.record.id)).toBe(true);
		expect(await getStore().get(created.record.id)).toBeNull();
		expect(await getStore().delete(created.record.id)).toBe(false);
	});

	it("update renames and clears optional fields", async () => {
		await getStore().update(created.record.id, { name: "renamed", mailboxes: ["x@example.com"] });
		let record = await getStore().get(created.record.id);
		expect(record!.name).toBe("renamed");
		expect(record!.mailboxes).toEqual(["x@example.com"]);

		await getStore().update(created.record.id, { mailboxes: null, expiresAt: null });
		record = await getStore().get(created.record.id);
		expect(record!.mailboxes).toBeNull();
		expect(record!.expires_at).toBeNull();
	});
});
