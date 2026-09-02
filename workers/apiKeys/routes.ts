// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * API key management routes: /api/v1/api-keys and /api/v1/me.
 *
 * Only Access (or dev) principals may manage keys — a key can never manage
 * keys, so a leaked key cannot mint replacements. The management routes are
 * mounted behind `requireAccessPrincipal`.
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireAccessPrincipal } from "../lib/auth";
import type { MailboxContext } from "../lib/mailbox";
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey, type ApiKeyRecord } from "./store";

type AppContext = Context<MailboxContext>;

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

/** Strip the key hash — responses never include it. */
function toPublicKey(record: ApiKeyRecord) {
	const { id, name, key_prefix, mailboxes, created_at, created_by, expires_at, last_used_at, revoked_at } = record;
	return { id, name, key_prefix, mailboxes, created_at, created_by, expires_at, last_used_at, revoked_at };
}

export const apiKeyRoutes = new Hono<MailboxContext>();

// Resolved principal, minus secrets. The CLI uses this for `auth status`.
apiKeyRoutes.get("/api/v1/me", (c) => {
	return c.json({ principal: c.var.principal });
});

apiKeyRoutes.use("/api/v1/api-keys/*", requireAccessPrincipal);

apiKeyRoutes.get("/api/v1/api-keys", async (c) => {
	const records = await getStore(c).list();
	return c.json({ keys: records.map(toPublicKey) });
});

apiKeyRoutes.post("/api/v1/api-keys", async (c) => {
	const body = CreateApiKeyBody.parse(await c.req.json());
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
});

apiKeyRoutes.patch("/api/v1/api-keys/:id", async (c) => {
	const body = UpdateApiKeyBody.parse(await c.req.json());
	const record = await getStore(c).update(c.req.param("id")!, {
		name: body.name,
		expiresAt: body.expires_at,
		mailboxes: body.mailboxes,
	});
	if (!record) return c.json({ error: { code: "not_found", message: "API key not found" } }, 404);
	return c.json({ key: toPublicKey(record) });
});

apiKeyRoutes.post("/api/v1/api-keys/:id/revoke", async (c) => {
	const record = await getStore(c).revoke(c.req.param("id")!);
	if (!record) return c.json({ error: { code: "not_found", message: "API key not found" } }, 404);
	return c.json({ key: toPublicKey(record) });
});

apiKeyRoutes.delete("/api/v1/api-keys/:id", async (c) => {
	const deleted = await getStore(c).delete(c.req.param("id")!);
	if (!deleted) return c.json({ error: { code: "not_found", message: "API key not found" } }, 404);
	return c.body(null, 204);
});
