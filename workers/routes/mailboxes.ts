// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { apiError, validationErrorHook } from "../lib/errors";
import type { MailboxContext } from "../lib/mailbox";
import { listMailboxes } from "../lib/email-helpers";
import { ApiErrorSchema, MailboxSchema } from "../lib/schemas";

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated: agentSystemPrompt goes straight to AI
});

const UpdateMailboxBody = z.object({
	settings: z.record(z.any()),
});

const MAILBOX_ID_PARAM = z.object({ mailboxId: z.string() });

export const mailboxRoutes = new Hono<MailboxContext>()
	.get(
		"/api/v1/mailboxes",
		describeRoute({
			description: "List every mailbox registered in this deployment.",
			responses: {
				200: {
					description: "Mailboxes",
					content: { "application/json": { schema: resolver(z.array(MailboxSchema)) } },
				},
			},
		}),
		async (c) => {
			const allMailboxes = await listMailboxes(c.env.BUCKET);
			// Scoped API keys only see the mailboxes in their scope (D4).
			const principal = c.get("principal");
			const scope = principal.kind === "api_key" ? principal.mailboxes : null;
			const visible = scope ? allMailboxes.filter((m) => scope.includes(m.id)) : allMailboxes;
			return c.json(visible.map((m) => ({ ...m, name: m.id })));
		},
	)
	.post(
		"/api/v1/mailboxes",
		describeRoute({
			description: "Create a mailbox. Restricted to configured EMAIL_ADDRESSES when set.",
			responses: {
				201: {
					description: "Created mailbox",
					content: { "application/json": { schema: resolver(MailboxSchema) } },
				},
				403: { description: "Mailbox address not allowed", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				409: { description: "Mailbox already exists", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("json", CreateMailboxBody, validationErrorHook),
		async (c) => {
			const { name, settings, email: rawEmail } = c.req.valid("json");
			const email = rawEmail.toLowerCase();
			const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
			if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
				return apiError(c, 403, "forbidden", "Mailbox creation is restricted to configured EMAIL_ADDRESSES");
			}
			const key = `mailboxes/${email}.json`;
			if (await c.env.BUCKET.head(key)) {
				return apiError(c, 409, "conflict", "Mailbox already exists");
			}
			const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
			const finalSettings = { ...defaultSettings, ...settings };
			await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
			const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
			await stub.getFolders();
			return c.json({ id: email, email, name, settings: finalSettings }, 201);
		},
	)
	.get(
		"/api/v1/mailboxes/:mailboxId",
		describeRoute({
			description: "Get a mailbox with its settings.",
			responses: {
				200: { description: "Mailbox", content: { "application/json": { schema: resolver(MailboxSchema) } } },
				404: { description: "Not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", MAILBOX_ID_PARAM, validationErrorHook),
		async (c) => {
			const mailboxId = c.req.valid("param").mailboxId;
			const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
			if (!obj) return apiError(c, 404, "not_found", "Mailbox not found");
			return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
		},
	)
	.put(
		"/api/v1/mailboxes/:mailboxId",
		describeRoute({
			description: "Replace a mailbox's settings object.",
			responses: {
				200: { description: "Updated mailbox", content: { "application/json": { schema: resolver(MailboxSchema) } } },
				404: { description: "Not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", MAILBOX_ID_PARAM, validationErrorHook),
		validator("json", UpdateMailboxBody, validationErrorHook),
		async (c) => {
			const mailboxId = c.req.valid("param").mailboxId;
			const { settings } = c.req.valid("json");
			const key = `mailboxes/${mailboxId}.json`;
			if (!(await c.env.BUCKET.head(key))) return apiError(c, 404, "not_found", "Mailbox not found");
			await c.env.BUCKET.put(key, JSON.stringify(settings));
			return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
		},
	)
	.delete(
		"/api/v1/mailboxes/:mailboxId",
		describeRoute({
			description: "Delete a mailbox's settings object. Mail data in the Durable Object is not removed.",
			responses: {
				204: { description: "Deleted" },
				404: { description: "Not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", MAILBOX_ID_PARAM, validationErrorHook),
		async (c) => {
			const mailboxId = c.req.valid("param").mailboxId;
			const key = `mailboxes/${mailboxId}.json`;
			if (!(await c.env.BUCKET.head(key))) return apiError(c, 404, "not_found", "Mailbox not found");
			await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
			return c.body(null, 204);
		},
	);
