// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Standard error envelope for the REST API:
 * `{ error: { code, message } }`.
 *
 * The UI's ApiError and the CLI both read `error.message` and treat `code`
 * as the stable identifier.
 */
import type { Hook } from "@hono/zod-validator";
import type { Context, Env as HonoEnv, ValidationTargets } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError } from "zod";

export type ApiErrorCode =
	| "bad_request"
	| "validation_failed"
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "conflict"
	| "rate_limited"
	| "verification_failed"
	| "send_failed"
	| "internal_error";

export function apiError<E extends HonoEnv>(
	c: Context<E, string>,
	status: ContentfulStatusCode,
	code: ApiErrorCode,
	message: string,
) {
	return c.json({ error: { code, message } }, status);
}

/**
 * Hook for the hono-openapi zod validator: turns zod failures into the
 * standard 400 envelope instead of @hono/zod-validator's default body.
 * Generic so it fits every validator target.
 */
export function validationErrorHook<T, E extends HonoEnv, P extends string, Target extends keyof ValidationTargets>(
	result: { success: true; data: T; target: Target } | { success: false; error: ZodError<T>; target: Target },
	c: Context<E, P>,
): Response | undefined {
	if (!result.success) {
		return apiError(
			c,
			400,
			"validation_failed",
			result.error.issues[0]?.message ?? "Invalid request",
		);
	}
	return undefined;
}

