// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "./context";
import { printJson, renderKv, renderTable } from "./output";

/**
 * Output a list resource: table on a TTY, JSON in pipes. Plain is compact
 * single-line JSON, for scripts that post-process the output.
 */
export function emitList<T>(ctx: Context, items: T[], columns: { header: string; cell: (item: T) => string }[]): void {
	if (ctx.format === "json") {
		printJson(items);
		return;
	}
	if (ctx.format === "plain") {
		process.stdout.write(`${JSON.stringify(items)}\n`);
		return;
	}
	process.stdout.write(
		`${renderTable(
			columns.map((c) => c.header),
			items.map((item) => columns.map((c) => c.cell(item))),
		)}\n`,
	);
}

/** Output a single resource: key-value block on a TTY, JSON otherwise. */
export function emitDetail<T>(ctx: Context, item: T, order: [string, (item: T) => string][]): void {
	if (ctx.format === "json") {
		printJson(item);
		return;
	}
	if (ctx.format === "plain") {
		process.stdout.write(`${JSON.stringify(item)}\n`);
		return;
	}
	process.stdout.write(`${renderKv(order.map(([key, get]) => [key, get(item)]))}\n`);
}
