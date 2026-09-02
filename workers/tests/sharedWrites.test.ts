// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Phase 3 check: the REST routes and the shared tool functions
 * (used by MCP/agent) produce the same Durable Object state for
 * equivalent inputs.
 *
 * verifyDraft is not exercised here because the pool has no AI binding;
 * the verify flag therefore stays false in these tests.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getMailboxStub } from "../lib/email-helpers";
import { toolDeleteEmail, toolSendEmail, toolSendReply } from "../lib/tools";
import type { MailboxDO } from "../durableObject";
import { fetchApi } from "./helpers";

const MAILBOX = "shared@example.com";

async function listFolder(folder: string) {
	const stub = getMailboxStub(env as never, MAILBOX);
	return stub.getEmails({ folder, limit: 50 });
}

function stubFor() {
	return getMailboxStub(env as never, MAILBOX) as DurableObjectStub<MailboxDO>;
}

beforeAll(async () => {
	await env.BUCKET.put(`mailboxes/${MAILBOX}.json`, JSON.stringify({ fromName: "Shared" }));
});

describe("send: REST route vs toolSendEmail", () => {
	it("produce the same sent-folder state", async () => {
		const rest = await fetchApi(`/api/v1/mailboxes/${MAILBOX}/emails`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				to: "dest@example.com",
				from: MAILBOX,
				subject: "REST send",
				text: "hello from rest",
			}),
		});
		expect(rest.status).toBe(202);

		const tool = await toolSendEmail(env as never, MAILBOX, {
			to: "dest@example.com",
			subject: "Tool send",
			text: "hello from tool",
			// No EMAIL binding in the test pool: defer like the REST route does.
			deferDelivery: { waitUntil: () => {} },
		});
		expect(tool).toMatchObject({ status: "sent" });

		type SentRow = {
			id: string;
			subject: string;
			sender: string;
			recipient: string;
			folder_id: string;
			read: boolean;
			thread_id: string | null;
		};
		const rows = (await listFolder("sent")) as unknown as SentRow[];
		const bySubject = Object.fromEntries(rows.map((r) => [r.subject, r]));

		const restRow = bySubject["REST send"];
		const toolRow = bySubject["Tool send"];
		expect(restRow).toBeDefined();
		expect(toolRow).toBeDefined();

		// Identical shape apart from content itself
		for (const row of [restRow, toolRow]) {
			expect(row.sender).toBe(MAILBOX);
			expect(row.recipient).toBe("dest@example.com");
			expect(row.folder_id).toBe("sent");
			expect(row.read).toBe(true); // sent mail is read
			expect(row.thread_id).toBe(row.id); // new thread
		}
	});
});

describe("reply: REST route vs toolSendReply", () => {
	it("land on the same thread with the same headers", async () => {
		// Seed an original inbox email.
		const stub = stubFor();
		const originalId = crypto.randomUUID();
		await stub.createEmail("inbox", {
			id: originalId,
			subject: "Please reply",
			sender: "someone@example.com",
			recipient: MAILBOX,
			date: new Date().toISOString(),
			body: "<p>Original question</p>",
			thread_id: "thread-1",
		}, []);

		const rest = await fetchApi(`/api/v1/mailboxes/${MAILBOX}/emails/${originalId}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				to: "someone@example.com",
				from: MAILBOX,
				subject: "Re: Please reply",
				text: "rest reply body",
			}),
		});
		expect(rest.status).toBe(202);
		const { id: restReplyId } = (await rest.json()) as { id: string };

		const tool = await toolSendReply(env as never, MAILBOX, {
			originalEmailId: originalId,
			to: "someone@example.com",
			subject: "Re: Please reply",
			text: "tool reply body",
			appendQuoted: false,
			// REST defers delivery; the tool defaults to sync which would need
			// the EMAIL binding — use the same defer shape without delivery.
			deferDelivery: { waitUntil: () => {} },
		});
		expect(tool).toMatchObject({ status: "sent" });
		const toolReplyId = (tool as { messageId: string }).messageId;

		const restReply = await stub.getEmail(restReplyId);
		const toolReply = await stub.getEmail(toolReplyId);
		expect(restReply).toBeDefined();
		expect(toolReply).toBeDefined();

		expect(restReply!.in_reply_to).toBe(originalId);
		expect(toolReply!.in_reply_to).toBe(originalId);
		expect(restReply!.thread_id).toBe("thread-1");
		expect(toolReply!.thread_id).toBe("thread-1");
		expect(restReply!.body).toBe("rest reply body");
		expect(toolReply!.body).toBe("tool reply body");
	});

	it("appends the quoted original for MCP by default", async () => {
		const stub = stubFor();
		const originalId = crypto.randomUUID();
		await stub.createEmail("inbox", {
			id: originalId,
			subject: "Quote me",
			sender: "quotee@example.com",
			recipient: MAILBOX,
			date: new Date().toISOString(),
			body: "<p>Distinctive original text</p>",
			thread_id: "thread-2",
		}, []);

		// MCP always sends an HTML body; the quoted block is appended by default.
		const tool = await toolSendReply(env as never, MAILBOX, {
			originalEmailId: originalId,
			to: "quotee@example.com",
			subject: "Re: Quote me",
			bodyHtml: "tool body",
			deferDelivery: { waitUntil: () => {} },
		});
		expect(tool).toMatchObject({ status: "sent" });
		const toolReplyId = (tool as { messageId: string }).messageId;

		const reply = await stub.getEmail(toolReplyId);
		expect(reply!.body).toContain("tool body");
		expect(reply!.body).toContain("blockquote");
	});
});

describe("delete: toolDeleteEmail with a bucket", () => {
	it("removes attachment blobs from R2", async () => {
		const stub = stubFor();
		const emailId = crypto.randomUUID();
		const attachmentId = crypto.randomUUID();
		await stub.createEmail("inbox", {
			id: emailId,
			subject: "With attachment",
			sender: "a@example.com",
			recipient: MAILBOX,
			date: new Date().toISOString(),
			body: "body",
		}, [{
			id: attachmentId,
			email_id: emailId,
			filename: "file.txt",
			mimetype: "text/plain",
			size: 5,
			content_id: null,
			disposition: "attachment",
		}]);
		const objectKey = `attachments/${emailId}/${attachmentId}/file.txt`;
		await env.BUCKET.put(objectKey, "hello");

		const result = await toolDeleteEmail(env as never, MAILBOX, emailId, env.BUCKET);
		expect(result).toMatchObject({ status: "deleted" });
		expect(await env.BUCKET.head(objectKey)).toBeNull();
	});
});
