// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, type Env as HonoEnv, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { apiError, validationErrorHook } from "../lib/errors";
import type { MailboxContext } from "../lib/mailbox";
import type { MailboxThreadedListReaderStub } from "../lib/email-helpers";
import {
	ApiErrorSchema,
	DraftResponseSchema,
	EmailFullSchema,
	EmailListResponseSchema,
	SendEmailRequestSchema,
	boolParam,
	limitParam,
	pageParam,
} from "../lib/schemas";
import { toolDeleteEmail, toolDraftReply, toolMarkEmailRead, toolMoveEmail, toolSendEmail, type ToolErrorCode } from "../lib/tools";

const ListEmailsQuery = z.object({
	folder: z.string().optional(),
	thread_id: z.string().optional(),
	threaded: boolParam,
	page: pageParam,
	limit: limitParam,
	sortColumn: z.enum(["id", "subject", "sender", "recipient", "date", "read", "starred"]).optional(),
	sortDirection: z.enum(["ASC", "DESC"]).optional(),
});

const UpdateEmailBody = z.object({
	read: z.boolean().optional(),
	starred: z.boolean().optional(),
});

const MoveEmailBody = z.object({
	folderId: z.string().min(1),
});

const DraftReplyBody = z.object({
	to: z.string().email(),
	subject: z.string().min(1),
	body: z.string(),
	/** Opt in to the AI draft verifier over the draft body (D3). */
	verify: z.boolean().optional(),
});

const EMAIL_ID_PARAM = z.object({ mailboxId: z.string(), id: z.string() });

/** Map tool error codes to the REST error envelope. */
function sendToolError<E extends HonoEnv>(c: Context<E, string>, result: { error: string; code?: ToolErrorCode }) {
	const status = result.code === "rate_limited" ? 429
		: result.code === "not_found" ? 404
		: 400;
	return apiError(c, status, result.code ?? "bad_request", result.error);
}

export const emailRoutes = new Hono<MailboxContext>()
	.get(
		"/api/v1/mailboxes/:mailboxId/emails",
		describeRoute({
			description:
				"List emails in a mailbox. Returns { emails, totalCount }. With threaded=true, each item is a conversation with thread_count/participants aggregates.",
			responses: {
				200: {
					description: "Paginated email list",
					content: { "application/json": { schema: resolver(EmailListResponseSchema) } },
				},
				404: { description: "Mailbox not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("query", ListEmailsQuery, validationErrorHook),
		async (c) => {
			const { folder, thread_id, threaded, page, limit, sortColumn, sortDirection } = c.req.valid("query");
			const stub = c.var.mailboxStub;

			if (threaded && folder) {
				const threadedStub = stub as unknown as MailboxThreadedListReaderStub;
				const emails = await threadedStub.getThreadedEmails({ folder, page, limit });
				const totalCount = await threadedStub.countThreadedEmails(folder);
				return c.json({ emails, totalCount });
			}
			const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
			const totalCount = await stub.countEmails({ folder, thread_id });
			return c.json({ emails, totalCount });
		},
	)
	.post(
		"/api/v1/mailboxes/:mailboxId/emails",
		describeRoute({
			description:
				"Send a new email. Delivery happens asynchronously; the created sent email is returned immediately. Rate limit: 20/hour, 100/day per mailbox.",
			responses: {
				202: {
					description: "Accepted for delivery",
					content: { "application/json": { schema: resolver(z.object({ id: z.string(), status: z.string() })) } },
				},
				400: { description: "Invalid sender", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				404: { description: "Mailbox not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				429: { description: "Rate limited", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("json", SendEmailRequestSchema, validationErrorHook),
		async (c) => {
			const mailboxId = c.req.param("mailboxId")!;
			const result = await toolSendEmail(c.env, mailboxId, {
				...c.req.valid("json"),
				deferDelivery: c.executionCtx,
			});
			if ("error" in result) {
				return sendToolError(c, result);
			}
			return c.json({ id: result.messageId, status: "sent" }, 202);
		},
	)
	.get(
		"/api/v1/mailboxes/:mailboxId/emails/:id",
		describeRoute({
			description: "Get a single email with body and attachments.",
			responses: {
				200: { description: "Email", content: { "application/json": { schema: resolver(EmailFullSchema) } } },
				404: { description: "Not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", EMAIL_ID_PARAM, validationErrorHook),
		async (c) => {
			const email = await c.var.mailboxStub.getEmail(c.req.valid("param").id);
			if (!email) return apiError(c, 404, "not_found", "Email not found");
			return c.json(email);
		},
	)
	.put(
		"/api/v1/mailboxes/:mailboxId/emails/:id",
		describeRoute({
			description: "Update an email's read and/or starred flags.",
			responses: {
				200: { description: "Updated email", content: { "application/json": { schema: resolver(EmailFullSchema) } } },
				404: { description: "Not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", EMAIL_ID_PARAM, validationErrorHook),
		validator("json", UpdateEmailBody, validationErrorHook),
		async (c) => {
			const { read, starred } = c.req.valid("json");
			if (read === undefined && starred === undefined) {
				return apiError(c, 400, "bad_request", "Provide read and/or starred");
			}
			const result = await toolMarkEmailRead(c.env, c.req.param("mailboxId")!, c.req.param("id")!, read, starred, true);
			return result.email ? c.json(result.email) : apiError(c, 404, "not_found", "Email not found");
		},
	)
	.delete(
		"/api/v1/mailboxes/:mailboxId/emails/:id",
		describeRoute({
			description: "Delete an email and its attachment blobs from R2.",
			responses: {
				204: { description: "Deleted" },
				404: { description: "Not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", EMAIL_ID_PARAM, validationErrorHook),
		async (c) => {
			const { mailboxId, id } = c.req.valid("param");
			const result = await toolDeleteEmail(c.env, mailboxId, id, c.env.BUCKET);
			if (!("error" in result)) return c.body(null, 204);
			return apiError(c, 404, "not_found", result.error);
		},
	)
	.post(
		"/api/v1/mailboxes/:mailboxId/emails/:id/move",
		describeRoute({
			description: "Move an email to a folder (folder id or name).",
			responses: {
				200: { description: "Moved", content: { "application/json": { schema: resolver(z.object({ status: z.literal("moved") })) } } },
				404: { description: "Folder not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", EMAIL_ID_PARAM, validationErrorHook),
		validator("json", MoveEmailBody, validationErrorHook),
		async (c) => {
			const result = await toolMoveEmail(c.env, c.req.param("mailboxId")!, c.req.param("id")!, c.req.valid("json").folderId);
			return "error" in result ? apiError(c, 404, "not_found", "Folder not found") : c.json({ status: "moved" });
		},
	)
	.post(
		"/api/v1/mailboxes/:mailboxId/emails/:id/draft-reply",
		describeRoute({
			description:
				"Draft a reply to an email: saves a draft in the Drafts folder with the quoted original appended and threading set up. Does not send.",
			responses: {
				201: {
					description: "Draft created",
					content: { "application/json": { schema: resolver(DraftResponseSchema) } },
				},
				404: { description: "Original email not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", EMAIL_ID_PARAM, validationErrorHook),
		validator("json", DraftReplyBody, validationErrorHook),
		async (c) => {
			const { mailboxId, id } = c.req.valid("param");
			const { to, subject, body, verify } = c.req.valid("json");
			const result = await toolDraftReply(c.env, mailboxId, {
				originalEmailId: id,
				to,
				subject,
				body,
				runVerifyDraft: verify,
			});
			if ("error" in result) return apiError(c, 404, "not_found", result.error);
			return c.json(
				{
					id: result.draftId,
					status: "draft",
					subject,
					recipient: to,
					date: new Date().toISOString(),
				},
				201,
			);
		},
	);
