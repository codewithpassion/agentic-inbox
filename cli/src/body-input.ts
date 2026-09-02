// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { readFileSync } from "node:fs";
import { usageError } from "./errors";

/**
 * Resolve --body <text> / --body-file <path> / --body - (stdin) into one
 * string. Exactly one source must be given.
 */
export async function resolveBodyInput(options: {
	body?: string;
	bodyFile?: string;
	commandName: string;
}): Promise<string> {
	const sources = [options.body !== undefined, options.bodyFile !== undefined].filter(Boolean).length;
	if (sources > 1) {
		throw usageError(`${options.commandName}: use only one of --body, --body-file, or --body -`);
	}
	if (options.bodyFile !== undefined) {
		return readFileSync(options.bodyFile, "utf8");
	}
	if (options.body === undefined) {
		throw usageError(`${options.commandName}: provide --body <text>, --body-file <path>, or --body -`);
	}
	if (options.body === "-") {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks).toString("utf8");
	}
	return options.body;
}
