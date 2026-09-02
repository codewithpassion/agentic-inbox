// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** CLI error with a stable exit code, rendered as the API error envelope. */
export class CliError extends Error {
	constructor(
		readonly exitCode: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "CliError";
	}
}

export function usageError(message: string): CliError {
	return new CliError(2, "usage", message);
}

export function confirmationRequired(
	message = "Confirmation required: pass --yes when not attached to a terminal",
): CliError {
	return new CliError(4, "confirmation_required", message);
}

export function unexpectedError(cause: unknown): CliError {
	const message = cause instanceof Error ? cause.message : String(cause);
	return new CliError(1, "internal_error", message);
}
