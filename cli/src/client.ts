// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import createClient from "openapi-fetch";
import type { ProfileConfig } from "./config";
import { usageError } from "./errors";
import type { paths } from "./generated/api";
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

export function baseUrl(settings: ProfileConfig): string {
	const url = settings.url?.trim();
	if (!url) {
		throw usageError("No base URL configured: pass --url, set INBOX_URL, or run `inbox auth login`");
	}
	return url.replace(/\/+$/, "");
}

function requireApiKey(settings: ProfileConfig): string {
	const key = settings.api_key?.trim();
	if (!key) {
		throw usageError("No API key configured: pass --api-key, set INBOX_API_KEY, or run `inbox auth login`");
	}
	return key;
}

/**
 * Typed client for the generated OpenAPI schema. The spec paths already
 * include /api/v1, so the base URL is the deployment origin.
 */
export function getClient(settings: ProfileConfig) {
	return createClient<paths>({
		baseUrl: baseUrl(settings),
		headers: settings.api_key ? { Authorization: `Bearer ${requireApiKey(settings)}` } : {},
	});
}

interface UnwrapResult<TData> {
	data?: TData;
	error?: unknown;
	response: Response;
}

/** Turn an openapi-fetch result into data, throwing ApiError on failures. */
export function unwrap<TData>(result: UnwrapResult<TData>): TData {
	if (result.response.ok && result.data !== undefined) return result.data;
	const status = result.response.status;
	if (result.error !== null && result.error !== undefined) {
		const envelope = result.error as { error?: { code?: string; message?: string } };
		if (envelope.error?.message) {
			throw new ApiError(status, envelope.error.code ?? `http_${status}`, envelope.error.message);
		}
	}
	throw new ApiError(status, `http_${status}`, `Request failed: ${status}`);
}

/**
 * Download a binary endpoint (attachments) with plain fetch so the body
 * streams to disk instead of being parsed.
 */
export async function download(settings: ProfileConfig, path: string, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = {
		...(init?.headers as Record<string, string> | undefined),
	};
	if (settings.api_key) headers.Authorization = `Bearer ${settings.api_key}`;
	return fetch(`${baseUrl(settings)}${path}`, { ...init, headers });
}
