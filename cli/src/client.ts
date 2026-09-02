// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { ProfileConfig } from "./config";
import { usageError } from "./errors";
import { ExitCode } from "./output";

/** API error with its envelope code, mapped to the CLI exit code table. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
		this.exitCode = exitCodeForStatus(status);
	}

	readonly exitCode: number;
}

/** Map an API status to the CLI exit code table. */
export function exitCodeForStatus(status: number): number {
	if (status === 401 || status === 403) return ExitCode.auth;
	if (status === 404) return ExitCode.notFound;
	if (status >= 400 && status < 500) return ExitCode.api;
	return ExitCode.unexpected;
}

export interface RequestContext {
	settings: ProfileConfig;
	signal?: AbortSignal;
}

function requireUrl(settings: ProfileConfig): string {
	const url = settings.url?.trim();
	if (!url) {
		throw usageError("No base URL configured: pass --url, set INBOX_URL, or run `inbox auth login`");
	}
	return url.replace(/\/+$/, "");
}

/** Minimal JSON request helper for endpoints without generated types yet. */
export async function apiRequest<T>(ctx: RequestContext, path: string, init?: RequestInit): Promise<T> {
	const url = `${requireUrl(ctx.settings)}${path}`;
	const headers: Record<string, string> = {
		Accept: "application/json",
		...(init?.headers as Record<string, string> | undefined),
	};
	if (ctx.settings.api_key) headers.Authorization = `Bearer ${ctx.settings.api_key}`;
	if (init?.body != null && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

	let response: Response;
	try {
		response = await fetch(url, { ...init, headers, signal: ctx.signal });
	} catch (cause) {
		throw new ApiError(0, "network_error", cause instanceof Error ? cause.message : String(cause));
	}

	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
		throw new ApiError(
			response.status,
			body.error?.code ?? `http_${response.status}`,
			body.error?.message ?? `Request failed: ${response.status}`,
		);
	}
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}
