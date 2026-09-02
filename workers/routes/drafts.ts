// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { validationErrorHook } from "../lib/errors";
import type { MailboxContext } from "../lib/mailbox";
import { ApiErrorSchema, DraftResponseSchema } from "../lib/schemas";
import { toolDraftEmail } from "../lib/tools";

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
	/** Opt in to the AI draft verifier over the draft body (D3). */
	verify: z.boolean().optional(),
});

export const draftRoutes = new Hono<MailboxContext>().post(
	"/api/v1/mailboxes/:mailboxId/drafts",
	describeRoute({
		description:
			"Create a draft, or replace an existing draft when draft_id is given (the old draft is deleted and recreated).",
		responses: {
			201: {
				description: "Draft created",
				content: { "application/json": { schema: resolver(DraftResponseSchema) } },
			},
		},
	}),
	validator("json", DraftBody, validationErrorHook),
	async (c) => {
		const mailboxId = c.req.param("mailboxId")!;
		const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id, verify } = c.req.valid("json");
		const stub = c.var.mailboxStub;
		if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer

		const result = await toolDraftEmail(c.env, mailboxId, {
			to,
			cc,
			bcc,
			subject: subject || "",
			body,
			in_reply_to,
			thread_id,
			runVerifyDraft: verify,
		});
		if ("error" in result) {
			return c.json({ error: { code: "verification_failed", message: result.error } }, 400);
		}
		return c.json(
			{
				id: result.draftId,
				status: "draft",
				subject: subject || "",
				recipient: to || "",
				date: result.date,
			},
			201,
		);
	},
);
