// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { receiveEmail } from "../index";
import { putForwardRule } from "../forwarding";
import { getMailboxStub } from "../lib/email-helpers";

const testEnv = env as unknown as Parameters<typeof receiveEmail>[1];

async function createMailbox(address: string) {
	await env.BUCKET.put(`mailboxes/${address}.json`, JSON.stringify({ fromName: address }));
}

function inbox(address: string) {
	return getMailboxStub(env as never, address).getEmails({ folder: "inbox", limit: 50 });
}

type Forward = (rcptTo: string) => Promise<unknown>;

async function deliver(envelopeTo: string, headers: string[], subject: string, forward: Forward = async () => {}) {
	const raw = new TextEncoder().encode(
		[`From: Sender <sender@elsewhere.example>`, ...headers, `Subject: ${subject}`, "", "Hello"].join("\r\n"),
	);
	const ctx = createExecutionContext();
	await receiveEmail(
		{ to: envelopeTo, raw: new Blob([raw]).stream(), rawSize: raw.byteLength, forward },
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

describe("receiveEmail forwarding", () => {
	const destination = "me@elsewhere.example";

	function recordForwards() {
		const forwarded: string[] = [];
		const forward: Forward = async (rcptTo) => {
			forwarded.push(rcptTo);
		};
		return { forwarded, forward };
	}

	async function addRule(source: string) {
		await putForwardRule(env.BUCKET, { source, destination, created_at: "2026-11-03T00:00:00.000Z", created_by: null });
	}

	beforeAll(async () => {
		await createMailbox("both@example.com");
		await addRule("alias@example.com");
		await addRule("both@example.com");
		await addRule("failing@example.com");
	});

	it("forwards mail for an address that has a rule and no mailbox", async () => {
		const { forwarded, forward } = recordForwards();
		await deliver("alias@example.com", ["To: alias@example.com"], "alias only", forward);
		expect(forwarded).toEqual([destination]);
	});

	it("matches the rule case-insensitively", async () => {
		const { forwarded, forward } = recordForwards();
		await deliver("Alias@Example.com", ["To: Alias@Example.com"], "alias mixed case", forward);
		expect(forwarded).toEqual([destination]);
	});

	it("stores and forwards when the address has both a mailbox and a rule", async () => {
		const { forwarded, forward } = recordForwards();
		await deliver("both@example.com", ["To: both@example.com"], "kept and forwarded", forward);
		expect(forwarded).toEqual([destination]);
		expect(await subjects("both@example.com")).toContain("kept and forwarded");
	});

	it("does not forward mail for an address with no rule", async () => {
		const { forwarded, forward } = recordForwards();
		await deliver("first@example.com", ["To: first@example.com"], "no rule", forward);
		expect(forwarded).toEqual([]);
		expect(await subjects("first@example.com")).toContain("no rule");
	});

	it("fails delivery when forwarding fails and no mailbox holds a copy", async () => {
		const rejecting: Forward = async () => {
			throw new Error("destination address not verified");
		};
		await expect(deliver("failing@example.com", ["To: failing@example.com"], "lost", rejecting)).rejects.toThrow(
			"destination address not verified",
		);
	});

	it("keeps the stored copy when forwarding fails", async () => {
		const rejecting: Forward = async () => {
			throw new Error("destination address not verified");
		};
		await deliver("both@example.com", ["To: both@example.com"], "stored despite failure", rejecting);
		expect(await subjects("both@example.com")).toContain("stored despite failure");
	});
});
