// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, test } from "bun:test";
import { exitCodeForStatus } from "../src/client";
import { CliError } from "../src/errors";
import { ExitCode, renderKv, renderTable, resolveFormat } from "../src/output";

describe("resolveFormat", () => {
	test("--json wins over everything", () => {
		expect(resolveFormat({ jsonFlag: true, formatFlag: "table", configFormat: "table", stdoutIsTTY: true })).toBe(
			"json",
		);
	});

	test("--format overrides config and TTY heuristic", () => {
		expect(resolveFormat({ formatFlag: "plain", configFormat: "json", stdoutIsTTY: true })).toBe("plain");
	});

	test("config format applies without flags", () => {
		expect(resolveFormat({ configFormat: "json", stdoutIsTTY: true })).toBe("json");
	});

	test("JSON when piped, table on a TTY", () => {
		expect(resolveFormat({ stdoutIsTTY: false })).toBe("json");
		expect(resolveFormat({ stdoutIsTTY: true })).toBe("table");
	});

	test("invalid format is a usage error", () => {
		expect(() => resolveFormat({ formatFlag: "yaml" })).toThrow(CliError);
		try {
			resolveFormat({ formatFlag: "yaml" });
		} catch (err) {
			expect((err as CliError).exitCode).toBe(ExitCode.usage);
		}
	});
});

describe("exit code mapping", () => {
	test("401/403 map to auth", () => {
		expect(exitCodeForStatus(401)).toBe(ExitCode.auth);
		expect(exitCodeForStatus(403)).toBe(ExitCode.auth);
	});
	test("404 maps to not found", () => {
		expect(exitCodeForStatus(404)).toBe(ExitCode.notFound);
	});
	test("other 4xx map to API rejection", () => {
		expect(exitCodeForStatus(400)).toBe(ExitCode.api);
		expect(exitCodeForStatus(409)).toBe(ExitCode.api);
		expect(exitCodeForStatus(429)).toBe(ExitCode.api);
	});
	test("5xx and network failures are unexpected", () => {
		expect(exitCodeForStatus(500)).toBe(ExitCode.unexpected);
		expect(exitCodeForStatus(0)).toBe(ExitCode.unexpected);
	});
});

describe("renderers", () => {
	test("renderTable aligns columns", () => {
		const table = renderTable(
			["NAME", "KEY"],
			[
				["aik_abc", "x"],
				["b", "longer-value"],
			],
		);
		const [header, rule, row1, row2] = table.split("\n");
		expect(header).toBe("NAME     KEY");
		expect(rule).toBe("-------  ------------");
		expect(row1).toBe("aik_abc  x");
		expect(row2).toBe("b        longer-value");
	});

	test("renderKv aligns keys", () => {
		const block = renderKv([
			["principal", "api_key"],
			["key", "aik_abc..."],
		]);
		expect(block).toBe("principal  api_key\nkey        aik_abc...");
	});
});
