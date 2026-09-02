// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { apiError, validationErrorHook } from "../lib/errors";
import type { MailboxContext } from "../lib/mailbox";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	type MailboxThreadedListReaderStub,
} from "../lib/email-helpers";
import {
	ApiErrorSchema,
	EmailFullSchema,
	EmailListResponseSchema,
	SendEmailRequestSchema,
	boolParam,
	limitParam,
	pageParam,
} from "../lib/schemas";
import { storeAttachments } from "../lib/attachments";
import { sendEmail } from "../email-sender";
import { Folders } from "../../shared/folders";

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

const EMAIL_ID_PARAM = z.object({ mailboxId: z.string(), id: z.string() });

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
				429: { description: "Rate limited", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("json", SendEmailRequestSchema, validationErrorHook),
		async (c) => {
			const mailboxId = c.req.param("mailboxId")!;
			const body = c.req.valid("json");
			const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

			let toStr: string, fromEmail: string, fromDomain: string;
			try {
				({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
			} catch (e) {
				if (e instanceof SenderValidationError) return apiError(c, 400, "bad_request", e.message);
				throw e;
			}

			const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
			const stub = c.var.mailboxStub;
			const rateLimitError = await stub.checkSendRateLimit();
			if (rateLimitError) return apiError(c, 429, "rate_limited", rateLimitError);
			const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

			await stub.createEmail(Folders.SENT, {
				id: messageId, subject, sender: fromEmail, recipient: toStr,
				cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
				bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
				date: new Date().toISOString(), body: html || text || "",
				in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
				thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
				raw_headers: JSON.stringify([
					{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
					{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
					...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
					...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
					{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
					{ key: "message-id", value: `<${outgoingMessageId}>` },
				]),
			}, attachmentData);

			c.executionCtx.waitUntil(
				sendEmail(c.env.EMAIL, {
					to, cc, bcc, from, subject, html, text,
					attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
					...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
				}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
			);
			return c.json({ id: messageId, status: "sent" }, 202);
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
			const email = await c.var.mailboxStub.updateEmail(c.req.valid("param").id, { read, starred });
			return email ? c.json(email) : apiError(c, 404, "not_found", "Email not found");
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
			const id = c.req.valid("param").id;
			const attachments = await c.var.mailboxStub.deleteEmail(id);
			if (attachments === null) return apiError(c, 404, "not_found", "Email not found");
			if (attachments.length > 0) {
				await c.env.BUCKET.delete(attachments.map((att) => `attachments/${id}/${att.id}/${att.filename}`));
			}
			return c.body(null, 204);
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
			const { folderId } = c.req.valid("json");
			const success = await c.var.mailboxStub.moveEmail(c.req.valid("param").id, folderId);
			return success ? c.json({ status: "moved" }) : apiError(c, 404, "not_found", "Folder not found");
		},
	);
