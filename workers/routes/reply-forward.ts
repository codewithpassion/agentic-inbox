// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, type Env as HonoEnv, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { apiError, validationErrorHook } from "../lib/errors";
import { toolSendReply, type ToolErrorCode } from "../lib/tools";
import type { MailboxContext } from "../lib/mailbox";
import { sendEmail } from "../email-sender";
import { storeAttachments } from "../lib/attachments";
import { ApiErrorSchema, SendEmailRequestSchema } from "../lib/schemas";
import type { EmailFull } from "../lib/schemas";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	resolveOriginalEmail,
} from "../lib/email-helpers";
import { Folders } from "../../shared/folders";

const EMAIL_ID_PARAM = z.object({ mailboxId: z.string(), id: z.string() });

/** Map tool error codes to the REST error envelope. */
function sendToolError<E extends HonoEnv>(c: Context<E, string>, result: { error: string; code?: ToolErrorCode }) {
	const status = result.code === "rate_limited" ? 429
		: result.code === "not_found" ? 404
		: 400;
	return apiError(c, status, result.code ?? "bad_request", result.error);
}

export const replyForwardRoutes = new Hono<MailboxContext>()
	.post(
		"/api/v1/mailboxes/:mailboxId/emails/:id/reply",
		describeRoute({
			description:
				"Send a reply to an email. Threading headers are derived from the original; delivery is asynchronous. Rate limit: 20/hour, 100/day per mailbox.",
			responses: {
				202: {
					description: "Accepted for delivery",
					content: { "application/json": { schema: resolver(z.object({ id: z.string(), status: z.string() })) } },
				},
				400: { description: "Invalid sender", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				404: { description: "Original email not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				429: { description: "Rate limited", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", EMAIL_ID_PARAM, validationErrorHook),
		validator("json", SendEmailRequestSchema, validationErrorHook),
		async (c) => {
			const mailboxId = c.req.valid("param").mailboxId;
			const { to, from, subject, html, text, verify } = c.req.valid("json");
			const result = await toolSendReply(c.env, mailboxId, {
				originalEmailId: c.req.valid("param").id,
				to,
				from,
				subject,
				bodyHtml: html,
				text,
				verify,
				// The UI composer already includes the quoted original.
				appendQuoted: false,
				markThreadRead: true,
				deferDelivery: c.executionCtx,
			});
			if ("error" in result) return sendToolError(c, result);
			return c.json({ id: result.messageId, status: "sent" }, 202);
		},
	)
	.post(
		"/api/v1/mailboxes/:mailboxId/emails/:id/forward",
		describeRoute({
			description: "Forward an email. Delivery is asynchronous. Rate limit: 20/hour, 100/day per mailbox.",
			responses: {
				202: {
					description: "Accepted for delivery",
					content: { "application/json": { schema: resolver(z.object({ id: z.string(), status: z.string() })) } },
				},
				400: { description: "Invalid sender", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				404: { description: "Original email not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				429: { description: "Rate limited", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", EMAIL_ID_PARAM, validationErrorHook),
		validator("json", SendEmailRequestSchema, validationErrorHook),
		async (c) => {
			const mailboxId = c.req.valid("param").mailboxId;
			const id = c.req.valid("param").id;
			const { to, cc, bcc, from, subject, html, text, attachments } = c.req.valid("json");

			const stub = c.var.mailboxStub;
			const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

			if (!rawOriginal) {
				return apiError(c, 404, "not_found", "Original email not found");
			}

			await resolveOriginalEmail(stub, rawOriginal);

			let toStr: string, fromEmail: string, fromDomain: string;
			try {
				({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
			} catch (e) {
				if (e instanceof SenderValidationError) return apiError(c, 400, "bad_request", e.message);
				throw e;
			}

			const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

			const rateLimitError = await stub.checkSendRateLimit();
			if (rateLimitError) {
				return apiError(c, 429, "rate_limited", rateLimitError);
			}

			const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

			await stub.createEmail(
				Folders.SENT,
				{
					id: messageId,
					subject,
					sender: fromEmail,
					recipient: toStr,
					cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
					bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
					date: new Date().toISOString(),
					body: html || text || "",
					in_reply_to: null,
					email_references: null,
					thread_id: messageId,
					message_id: outgoingMessageId,
					raw_headers: JSON.stringify([
						{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
						{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
						...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
						...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
						{ key: "subject", value: subject },
						{ key: "date", value: new Date().toISOString() },
						{ key: "message-id", value: `<${outgoingMessageId}>` },
					]),
				},
				attachmentData,
			);

			c.executionCtx.waitUntil(
				sendEmail(c.env.EMAIL, {
					to,
					cc,
					bcc,
					from,
					subject,
					html,
					text,
					attachments: attachments?.map((att) => ({
						content: att.content,
						filename: att.filename,
						type: att.type,
						disposition: att.disposition,
						contentId: att.contentId,
					})),
				}).catch((e) => {
					console.error("Deferred forward delivery failed:", (e as Error).message);
				}),
			);

			return c.json({ id: messageId, status: "sent" }, 202);
		},
	);
