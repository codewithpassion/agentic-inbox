// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { receiveEmail } from "../index";
import { getMailboxStub } from "../lib/email-helpers";

const testEnv = env as unknown as Parameters<typeof receiveEmail>[1];

async function createMailbox(address: string) {
	await env.BUCKET.put(`mailboxes/${address}.json`, JSON.stringify({ fromName: address }));
}

function inbox(address: string) {
	return getMailboxStub(env as never, address).getEmails({ folder: "inbox", limit: 50 });
}

async function deliver(envelopeTo: string, headers: string[], subject: string) {
	const raw = new TextEncoder().encode(
		[`From: Sender <sender@elsewhere.example>`, ...headers, `Subject: ${subject}`, "", "Hello"].join("\r\n"),
	);
	const ctx = createExecutionContext();
	await receiveEmail(
		{ to: envelopeTo, raw: new Blob([raw]).stream(), rawSize: raw.byteLength },
		testEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
}

async function subjects(address: string) {
	return (await inbox(address)).map((email: { subject: string | null }) => email.subject);
}

describe("receiveEmail routing", () => {
	beforeAll(async () => {
		await createMailbox("first@example.com");
		await createMailbox("second@example.com");
	});

	it("delivers when another recipient is listed first in To", async () => {
		await deliver(
			"first@example.com",
			["To: stranger@elsewhere.example, first@example.com"],
			"stranger listed first",
		);
		expect(await subjects("first@example.com")).toContain("stranger listed first");
	});

	it("delivers to a mailbox named only in Cc", async () => {
		await deliver("first@example.com", ["To: stranger@elsewhere.example", "Cc: first@example.com"], "cc only");
		expect(await subjects("first@example.com")).toContain("cc only");
	});

	it("delivers a Bcc copy that names the mailbox in no header", async () => {
		await deliver("first@example.com", ["To: stranger@elsewhere.example"], "bcc copy");
		expect(await subjects("first@example.com")).toContain("bcc copy");
	});

	it("delivers mail with no To header and records the mailbox as recipient", async () => {
		await deliver("first@example.com", [], "no to header");
		const email = (await inbox("first@example.com")).find(
			(e: { subject: string | null }) => e.subject === "no to header",
		);
		expect(email?.recipient).toBe("first@example.com");
	});

	it("files one copy per mailbox when two mailboxes share a message", async () => {
		const headers = ["To: first@example.com, second@example.com"];
		await deliver("first@example.com", headers, "shared message");
		await deliver("second@example.com", headers, "shared message");
		const inFirst = (await subjects("first@example.com")).filter((s: string | null) => s === "shared message");
		const inSecond = (await subjects("second@example.com")).filter((s: string | null) => s === "shared message");
		expect(inFirst).toHaveLength(1);
		expect(inSecond).toHaveLength(1);
	});

	it("matches the envelope address case-insensitively", async () => {
		await deliver("First@Example.com", ["To: First@Example.com"], "mixed case");
		expect(await subjects("first@example.com")).toContain("mixed case");
	});

	it("ignores mail for an address with no mailbox", async () => {
		await deliver("nobody@example.com", ["To: first@example.com"], "not for us");
		expect(await subjects("first@example.com")).not.toContain("not for us");
	});
});
