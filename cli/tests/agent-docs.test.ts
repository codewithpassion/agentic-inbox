// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, test } from "bun:test";
import { runCli } from "../src/main";

async function agentDocs(args: string[] = []): Promise<string> {
	const chunks: string[] = [];
	const orig = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	};
	try {
		await runCli(["agent-docs", ...args]);
	} finally {
		process.stdout.write = orig;
	}
	return chunks.join("");
}

describe("agent-docs", () => {
	test("is byte-stable between runs", async () => {
		const first = await agentDocs();
		const second = await agentDocs();
		expect(first).toBe(second);
		expect(first.length).toBeGreaterThan(1000);
	});

	test("stays small enough for a system prompt (under ~4k tokens / 16k chars)", async () => {
		const docs = await agentDocs();
		expect(docs.length).toBeLessThan(16_000);
	});

	test("covers every command group", async () => {
		const docs = await agentDocs();
		for (const group of ["auth", "mailboxes", "emails", "threads", "drafts", "folders", "attachments"]) {
			expect(docs).toContain(`${group} - `);
		}
	});

	test("--command scopes the output to a single group", async () => {
		const docs = await agentDocs(["--command", "emails"]);
		expect(docs).toContain("emails - ");
		expect(docs).not.toContain("drafts - ");
		expect(docs).not.toContain("auth - ");
	});
});
