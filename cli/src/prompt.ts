// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { confirmationRequired, usageError } from "./errors";

/** Read a line from stdin (TTY or piped). */
export function readLine(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		process.stderr.write(prompt);
		let buffer = "";
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (buffer.includes("\n")) {
				cleanup();
				resolve(buffer.replace(/\r?\n.*$/s, ""));
			}
		};
		const cleanup = () => {
			process.stdin.removeListener("data", onData);
			process.stdin.pause();
		};
		process.stdin.resume();
		process.stdin.on("data", onData);
	});
}

/**
 * Read a secret without echoing it, using raw terminal mode.
 * Falls back to a normal (echoed) read when the terminal does not
 * support raw mode.
 */
export function readHidden(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) return Promise.resolve("");
	return new Promise((resolve) => {
		process.stderr.write(prompt);
		let buffer = "";
		let raw = false;
		const cleanup = () => {
			process.stdin.removeListener("data", onData);
			process.stdin.removeListener("end", onEnd);
			if (raw && process.stdin.isTTY) process.stdin.setRawMode(false);
			process.stdin.pause();
		};
		const finish = (value: string) => {
			cleanup();
			process.stderr.write("\n");
			resolve(value);
		};
		const onData = (chunk: Buffer) => {
			for (const char of chunk.toString("utf8")) {
				if (char === "\r" || char === "\n") {
					finish(buffer);
					return;
				}
				if (char === "\u0003") {
					// Ctrl-C
					finish("");
					process.kill(process.pid, "SIGINT");
					return;
				}
				if (char === "\u007f" || char === "\b") {
					buffer = buffer.slice(0, -1);
				} else {
					buffer += char;
				}
			}
		};
		const onEnd = () => finish(buffer);
		try {
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(true);
				raw = true;
			}
		} catch {
			// Raw mode unsupported (e.g. redirected input): read normally.
		}
		process.stdin.on("data", onData);
		process.stdin.on("end", onEnd);
	});
}

/**
 * Confirm a destructive action. With --yes or a piped session this never
 * prompts: no --yes outside a TTY fails with the confirmation exit code.
 */
export async function confirmOrFail(
	options: { yes: boolean; stdoutIsTTY: boolean; stdinIsTTY?: boolean },
	prompt: string,
): Promise<void> {
	if (options.yes) return;
	const interactive = (options.stdinIsTTY ?? process.stdin.isTTY ?? false) && options.stdoutIsTTY;
	if (!interactive) throw confirmationRequired();
	const answer = await readLine(`${prompt} [y/N] `);
	if (!/^(y|yes)$/i.test(answer.trim())) {
		throw usageError("Aborted");
	}
}
