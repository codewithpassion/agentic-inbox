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
import { apiError } from "../lib/errors";
import { toolDraftEmail, toolDiscardDraft, toolUpdateDraft } from "../lib/tools";

const DRAFT_ID_PARAM = z.object({ mailboxId: z.string(), draftId: z.string() });

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

const UpdateDraftBody = z.object({
	to: z.string().optional(),
	subject: z.string().optional(),
	body: z.string().optional(),
	/** Opt in to the AI draft verifier over the updated body (D3). */
	verify: z.boolean().optional(),
});

export const draftRoutes = new Hono<MailboxContext>()
	.post(
		"/api/v1/mailboxes/:mailboxId/drafts",
		describeRoute({
			description:
				"Create a draft, or replace an existing draft when draft_id is given (the old draft is deleted and recreated).",
			responses: {
				201: {
					description: "Draft created",
					content: { "application/json": { schema: resolver(DraftResponseSchema) } },
				},
				404: { description: "Mailbox not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("json", DraftBody, validationErrorHook),
		async (c) => {
			const mailboxId = c.req.param("mailboxId")!;
			const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id, verify } = c.req.valid("json");
			const stub = c.var.mailboxStub;

			// Create the new draft first and only delete the replaced one on
			// success, so a failed verification cannot lose the old draft.
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
			if (draft_id) await stub.deleteEmail(draft_id);

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
	)
	.patch(
		"/api/v1/mailboxes/:mailboxId/drafts/:draftId",
		describeRoute({
			description:
				"Update a draft in place: the old draft is deleted and recreated with a new id. Omitted fields carry over from the old draft.",
			responses: {
				200: {
					description: "Draft updated (new id)",
					content: { "application/json": { schema: resolver(DraftResponseSchema) } },
				},
				404: { description: "Draft not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", DRAFT_ID_PARAM, validationErrorHook),
		validator("json", UpdateDraftBody, validationErrorHook),
		async (c) => {
			const { mailboxId, draftId } = c.req.valid("param");
			const { to, subject, body, verify } = c.req.valid("json");
			const result = await toolUpdateDraft(c.env, mailboxId, {
				draftId,
				to,
				subject,
				bodyHtml: body,
				runVerifyDraft: verify,
			});
			if ("error" in result) return apiError(c, 404, "not_found", result.error);
			return c.json({
				id: result.newDraftId,
				status: result.status,
				subject: result.subject,
				recipient: result.recipient,
				date: result.date,
			});
		},
	)
	.delete(
		"/api/v1/mailboxes/:mailboxId/drafts/:draftId",
		describeRoute({
			description: "Discard a draft. Only emails in the Drafts folder can be discarded.",
			responses: {
				204: { description: "Discarded" },
				404: { description: "Draft not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				400: { description: "Not a draft", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", DRAFT_ID_PARAM, validationErrorHook),
		async (c) => {
			const { mailboxId, draftId } = c.req.valid("param");
			const result = await toolDiscardDraft(c.env, mailboxId, draftId);
			if (!("error" in result)) return c.body(null, 204);
			const message = result.error;
			return message === "Draft not found"
				? apiError(c, 404, "not_found", message)
				: apiError(c, 400, "bad_request", message);
		},
	);
