// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { CliError } from "./errors";

/** Stable exit codes (docs/02-cli-plan.md). */
export const ExitCode = {
	ok: 0,
	unexpected: 1,
	usage: 2,
	api: 3,
	confirmation: 4,
	auth: 5,
	notFound: 6,
} as const;

export type OutputFormat = "json" | "table" | "plain";

/**
 * Decide the output format: --json wins, then --format, then the config
 * file, then a TTY heuristic (table for humans, JSON for pipes).
 */
export function resolveFormat(options: {
	jsonFlag?: boolean;
	formatFlag?: string;
	configFormat?: string;
	stdoutIsTTY?: boolean;
}): OutputFormat {
	if (options.jsonFlag) return "json";
	const declared = options.formatFlag ?? options.configFormat;
	if (declared === "json" || declared === "table" || declared === "plain") return declared;
	if (declared !== undefined) {
		throw new CliError(2, "usage", `Invalid --format "${declared}": use json, table, or plain`);
	}
	return options.stdoutIsTTY ? "table" : "json";
}

/** JSON goes to stdout and nothing else does. */
export function printJson(data: unknown): void {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** Errors go to stderr in the API's envelope when piped, readable text on a TTY. */
export function printError(code: string, message: string, stderrIsTTY = process.stderr.isTTY ?? false): void {
	if (stderrIsTTY && !process.env.NO_COLOR) {
		process.stderr.write(`\x1b[31merror\x1b[0m (${code}): ${message}\n`);
	} else {
		process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
	}
}

/** Aligned text table: first row is the header. Trailing padding is trimmed. */
export function renderTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cells: string[]) =>
		cells
			.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

/** Key-value block for single objects. */
export function renderKv(pairs: [string, string][]): string {
	const width = Math.max(0, ...pairs.map(([k]) => k.length));
	return pairs.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}

/** Colour only on a TTY and never when NO_COLOR is set. */
export function colorize(text: string, tty: boolean, style: "green" | "red" | "dim"): string {
	if (!tty || process.env.NO_COLOR) return text;
	const codes = { green: 32, red: 31, dim: 2 } as const;
	return `\x1b[${codes[style]}m${text}\x1b[0m`;
}
