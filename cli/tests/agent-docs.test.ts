// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import path from "node:path";

const MAIN = path.join(import.meta.dir, "..", "src", "main.ts");

function runAgentDocs(...args: string[]): string {
	return execFileSync("bun", [MAIN, "agent-docs", ...args], { encoding: "utf8" });
}

describe("agent-docs", () => {
	test("is byte-stable between runs", () => {
		const first = runAgentDocs();
		const second = runAgentDocs();
		expect(first).toBe(second);
		expect(first.length).toBeGreaterThan(1000);
	});

	test("stays small enough for a system prompt (under ~4k tokens / 16k chars)", () => {
		const docs = runAgentDocs();
		expect(docs.length).toBeLessThan(16_000);
	});

	test("covers every command group", () => {
		const docs = runAgentDocs();
		for (const group of ["auth", "mailboxes", "emails", "threads", "drafts", "folders", "attachments"]) {
			expect(docs).toContain(`${group} - `);
		}
	});
});
