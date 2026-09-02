// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Principal } from "./auth";
import type { Env } from "../types";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		principal: Principal;
		mailboxStub: DurableObjectStub<MailboxDO>;
	};
};

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: { code: "bad_request", message: "Mailbox ID required" } }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// API keys restricted to specific mailboxes get a 404 (not 403) so they
	// cannot enumerate mailboxes outside their scope (decision D4).
	const principal = c.get("principal");
	if (principal.kind === "api_key" && principal.mailboxes && !principal.mailboxes.includes(mailboxId)) {
		return c.json({ error: { code: "not_found", message: "Mailbox not found" } }, 404);
	}

	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: { code: "not_found", message: "Mailbox not found" } }, 404);
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	c.set("mailboxStub", stub);

	await next();
});
