// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "../apiKeys/store";
import { getMailboxStub } from "../lib/email-helpers";
import { fetchApi, getApiKeyStore } from "./helpers";

const MAILBOX = "scoped@example.com";
const OTHER = "other@example.com";

const getStore = getApiKeyStore;

beforeAll(async () => {
	for (const mailbox of [MAILBOX, OTHER]) {
		await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({ fromName: mailbox }));
	}
});

/** Seed an email and return its id. */
async function seedEmail(mailbox: string, folder = "inbox", subject = "Seed") {
	const stub = getMailboxStub(env as never, mailbox);
	const id = crypto.randomUUID();
	await stub.createEmail(folder, {
		id,
		subject,
		sender: "writer@example.com",
		recipient: mailbox,
		date: new Date().toISOString(),
		body: "<p>seed body</p>",
		thread_id: `thread-${id}`,
	}, []);
	return id;
}

async function createScopedKey(mailboxes: string[] | null) {
	const secret = generateApiKey();
	const record = await getStore().create({
		name: "scoped",
		keyHash: await hashApiKey(secret),
		keyPrefix: secret.slice(0, 12),
		mailboxes,
	});
	return { secret, record };
}

function authed(secret: string): RequestInit {
	return { headers: { Authorization: `Bearer ${secret}` } };
}

describe("mailbox scoping (D4)", () => {
	it("filters GET /mailboxes to the key's scope", async () => {
		const { secret } = await createScopedKey([MAILBOX]);
		const response = await fetchApi("/api/v1/mailboxes", authed(secret));
		expect(response.status).toBe(200);
		const list = (await response.json()) as { id: string }[];
		expect(list.map((m) => m.id)).toContain(MAILBOX);
		expect(list.map((m) => m.id)).not.toContain(OTHER);
	});

	it("unscoped keys see every mailbox", async () => {
		const { secret } = await createScopedKey(null);
		const response = await fetchApi("/api/v1/mailboxes", authed(secret));
		const list = (await response.json()) as { id: string }[];
		expect(list.map((m) => m.id)).toEqual(expect.arrayContaining([MAILBOX, OTHER]));
	});

	it("returns 404 for out-of-scope mailboxes on mailbox routes", async () => {
		const { secret } = await createScopedKey([MAILBOX]);
		const response = await fetchApi(`/api/v1/mailboxes/${OTHER}/emails`, authed(secret));
		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body).toMatchObject({ error: { code: "not_found" } });
	});

	it("returns 200 for in-scope mailboxes", async () => {
		const { secret } = await createScopedKey([MAILBOX]);
		const response = await fetchApi(`/api/v1/mailboxes/${MAILBOX}/emails`, authed(secret));
		expect(response.status).toBe(200);
	});
});

describe("parity endpoints", () => {
	it("draft-reply stores a draft quoting the original", async () => {
		const originalId = await seedEmail(MAILBOX, "inbox", "Original for draft");
		const response = await fetchApi(`/api/v1/mailboxes/${MAILBOX}/emails/${originalId}/draft-reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ to: "writer@example.com", subject: "Re: Original for draft", body: "my reply text" }),
		});
		expect(response.status).toBe(201);
		const { id: draftId } = (await response.json()) as { id: string };

		const draft = await getMailboxStub(env as never, MAILBOX).getEmail(draftId);
		expect(draft).not.toBeNull();
		expect(draft!.folder_id).toBe("draft");
		expect(draft!.in_reply_to).toBe(originalId);
		expect(draft!.body).toContain("my reply text");
		expect(draft!.body).toContain("blockquote"); // quoted original appended
	});

	it("PATCH draft recreates it with a new id", async () => {
		const create = await fetchApi(`/api/v1/mailboxes/${MAILBOX}/drafts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ to: "x@example.com", subject: "Before", body: "old body" }),
		});
		const { id: oldId } = (await create.json()) as { id: string };

		const patch = await fetchApi(`/api/v1/mailboxes/${MAILBOX}/drafts/${oldId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ subject: "After", body: "new body" }),
		});
		expect(patch.status).toBe(200);
		const { id: newId } = (await patch.json()) as { id: string };
		expect(newId).not.toBe(oldId);

		const stub = getMailboxStub(env as never, MAILBOX);
		expect(await stub.getEmail(oldId)).toBeNull();
		const updated = await stub.getEmail(newId);
		expect(updated!.subject).toBe("After");
		expect(updated!.body).toBe("new body");
		// Recipient carries over when omitted
		expect(updated!.recipient).toBe("x@example.com");
	});

	it("PATCH returns 404 for a missing draft", async () => {
		const patch = await fetchApi(`/api/v1/mailboxes/${MAILBOX}/drafts/${crypto.randomUUID()}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ subject: "x" }),
		});
		expect(patch.status).toBe(404);
	});

	it("DELETE discards a draft and 404s for a non-draft email", async () => {
		const { id: draftId } = (await (
			await fetchApi(`/api/v1/mailboxes/${MAILBOX}/drafts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body: "to discard" }),
			})
		).json()) as { id: string };

		const del = await fetchApi(`/api/v1/mailboxes/${MAILBOX}/drafts/${draftId}`, { method: "DELETE" });
		expect(del.status).toBe(204);
		expect(await getMailboxStub(env as never, MAILBOX).getEmail(draftId)).toBeNull();

		const inboxId = await seedEmail(MAILBOX, "inbox", "Not a draft");
		const wrongFolder = await fetchApi(`/api/v1/mailboxes/${MAILBOX}/drafts/${inboxId}`, { method: "DELETE" });
		expect(wrongFolder.status).toBe(400);
	});
});
