// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { resolveBodyInput } from "../src/body-input";
import { CliError } from "../src/errors";

const dir = mkdtempSync(path.join(tmpdir(), "inbox-body-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveBodyInput", () => {
	test("--body passes the text through", async () => {
		expect(await resolveBodyInput({ body: "hello", commandName: "send" })).toBe("hello");
	});

	test("--body-file reads the file", async () => {
		const file = path.join(dir, "body.txt");
		writeFileSync(file, "file body");
		expect(await resolveBodyInput({ bodyFile: file, commandName: "send" })).toBe("file body");
	});

	test("rejects more than one source", async () => {
		await expect(resolveBodyInput({ body: "a", bodyFile: "/tmp/x", commandName: "send" })).rejects.toThrow(CliError);
	});

	test("rejects no source", async () => {
		await expect(resolveBodyInput({ commandName: "send" })).rejects.toThrow(CliError);
	});

	test("errors carry the usage exit code", async () => {
		try {
			await resolveBodyInput({ body: "a", bodyFile: "/tmp/x", commandName: "send" });
			expect.unreachable();
		} catch (err) {
			expect((err as CliError).exitCode).toBe(2);
		}
	});
});
