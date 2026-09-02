// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * API key management routes: /api/v1/api-keys and /api/v1/me.
 *
 * Only Access (or dev) principals may manage keys. A key can never manage
 * keys, so a leaked key cannot mint replacements. The management routes are
 * mounted behind `requireAccessPrincipal`.
 */
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { requireAccessPrincipal } from "../lib/auth";
import { validationErrorHook } from "../lib/errors";
import type { MailboxContext } from "../lib/mailbox";
import { ApiErrorSchema } from "../lib/schemas";
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey, type ApiKeyRecord } from "./store";

type AppContext = Context<MailboxContext>;

/** Key shape returned by the management endpoints (no hash, no secret). */
const PublicApiKeySchema = z.object({
	id: z.string(),
	name: z.string(),
	key_prefix: z.string(),
	mailboxes: z.array(z.string()).nullable(),
	created_at: z.string(),
	created_by: z.string().nullable(),
	expires_at: z.string().nullable(),
	last_used_at: z.string().nullable(),
	revoked_at: z.string().nullable(),
});

const CreateApiKeyBody = z.object({
	name: z.string().min(1),
	/** ISO timestamp; null clears an existing expiry. */
	expires_at: z.string().datetime().nullable().optional(),
	/** Mailbox ids the key may access; null/undefined means all mailboxes. */
	mailboxes: z.array(z.string()).nullable().optional(),
});

const UpdateApiKeyBody = z.object({
	name: z.string().min(1).optional(),
	expires_at: z.string().datetime().nullable().optional(),
	mailboxes: z.array(z.string()).nullable().optional(),
});

function getStore(c: AppContext) {
	return c.env.API_KEYS.get(c.env.API_KEYS.idFromName("global"));
}

/** Strip the key hash: responses never include it. */
function toPublicKey(record: ApiKeyRecord) {
	const { id, name, key_prefix, mailboxes, created_at, created_by, expires_at, last_used_at, revoked_at } = record;
	return { id, name, key_prefix, mailboxes, created_at, created_by, expires_at, last_used_at, revoked_at };
}

const FORBIDDEN_403 = {
	description: "API keys cannot manage keys",
	content: { "application/json": { schema: resolver(ApiErrorSchema) } },
};

const NOT_FOUND_404 = {
	description: "Key not found",
	content: { "application/json": { schema: resolver(ApiErrorSchema) } },
};

export const apiKeyRoutes = new Hono<MailboxContext>();

// Resolved principal, minus secrets. The CLI uses this for `auth status`.
apiKeyRoutes.get(
	"/api/v1/me",
	describeRoute({
		description: "The authenticated principal: Access identity, API key with its mailbox scope, or dev.",
		responses: {
			200: {
				description: "Principal",
				content: {
					"application/json": {
						schema: resolver(
							z.object({
								principal: z.union([
									z.object({ kind: z.literal("access"), email: z.string() }),
									z.object({
										kind: z.literal("api_key"),
										keyId: z.string(),
										name: z.string(),
										mailboxes: z.array(z.string()).nullable(),
										keyPrefix: z.string(),
									}),
									z.object({ kind: z.literal("dev") }),
								]),
							}),
						),
					},
				},
			},
		},
	}),
	(c) => {
		return c.json({ principal: c.var.principal });
	},
);

apiKeyRoutes.use("/api/v1/api-keys/*", requireAccessPrincipal);

apiKeyRoutes.get(
	"/api/v1/api-keys",
	describeRoute({
		description: "List API keys. The key hash and plaintext secret are never included.",
		responses: {
			200: {
				description: "Keys",
				content: { "application/json": { schema: resolver(z.object({ keys: z.array(PublicApiKeySchema) })) } },
			},
			403: FORBIDDEN_403,
		},
	}),
	async (c) => {
		const records = await getStore(c).list();
		return c.json({ keys: records.map(toPublicKey) });
	},
);

apiKeyRoutes.post(
	"/api/v1/api-keys",
	describeRoute({
		description:
			"Create an API key. The plaintext secret (aik_...) is returned exactly once in `secret`; only a SHA-256 hash is stored.",
		responses: {
			201: {
				description: "Created key with its plaintext secret",
				content: {
					"application/json": { schema: resolver(z.object({ key: PublicApiKeySchema, secret: z.string() })) },
				},
			},
			403: FORBIDDEN_403,
		},
	}),
	validator("json", CreateApiKeyBody, validationErrorHook),
	async (c) => {
		const body = c.req.valid("json");
		const principal = c.var.principal;
		const createdBy = principal.kind === "access" ? principal.email : null;

		const secret = generateApiKey();
		const record = await getStore(c).create({
			name: body.name,
			keyHash: await hashApiKey(secret),
			keyPrefix: apiKeyDisplayPrefix(secret),
			mailboxes: body.mailboxes ?? null,
			createdBy,
			expiresAt: body.expires_at ?? null,
		});

		return c.json({ key: toPublicKey(record), secret }, 201);
	},
);

apiKeyRoutes.patch(
	"/api/v1/api-keys/:id",
	describeRoute({
		description: "Rename a key, change its expiry, or change its mailbox scope (null clears a field).",
		responses: {
			200: {
				description: "Updated key",
				content: { "application/json": { schema: resolver(z.object({ key: PublicApiKeySchema })) } },
			},
			403: FORBIDDEN_403,
			404: NOT_FOUND_404,
		},
	}),
	validator("json", UpdateApiKeyBody, validationErrorHook),
	async (c) => {
		const body = c.req.valid("json");
		const record = await getStore(c).update(c.req.param("id")!, {
			name: body.name,
			expiresAt: body.expires_at,
			mailboxes: body.mailboxes,
		});
		if (!record) return c.json({ error: { code: "not_found", message: "API key not found" } }, 404);
		return c.json({ key: toPublicKey(record) });
	},
);

apiKeyRoutes.post(
	"/api/v1/api-keys/:id/revoke",
	describeRoute({
		description: "Revoke a key. Verification fails immediately; the record stays for auditing.",
		responses: {
			200: {
				description: "Revoked key",
				content: { "application/json": { schema: resolver(z.object({ key: PublicApiKeySchema })) } },
			},
			403: FORBIDDEN_403,
			404: NOT_FOUND_404,
		},
	}),
	async (c) => {
		const record = await getStore(c).revoke(c.req.param("id")!);
		if (!record) return c.json({ error: { code: "not_found", message: "API key not found" } }, 404);
		return c.json({ key: toPublicKey(record) });
	},
);

apiKeyRoutes.delete(
	"/api/v1/api-keys/:id",
	describeRoute({
		description: "Delete a key permanently. Requests using it stop working immediately.",
		responses: {
			204: { description: "Deleted" },
			403: FORBIDDEN_403,
			404: NOT_FOUND_404,
		},
	}),
	async (c) => {
		const deleted = await getStore(c).delete(c.req.param("id")!);
		if (!deleted) return c.json({ error: { code: "not_found", message: "API key not found" } }, 404);
		return c.body(null, 204);
	},
);
