// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { apiError, validationErrorHook } from "../lib/errors";
import type { MailboxContext } from "../lib/mailbox";
import { ApiErrorSchema } from "../lib/schemas";

const ATTACHMENT_PARAM = z.object({
	mailboxId: z.string(),
	emailId: z.string(),
	attachmentId: z.string(),
});

export const attachmentRoutes = new Hono<MailboxContext>().get(
	"/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId",
	describeRoute({
		description: "Download an attachment. Returns the raw file as a binary download.",
		responses: {
			200: { description: "Attachment file", content: { "*/*": { schema: resolver(z.string()) } } },
			404: { description: "Attachment not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
		},
	}),
	validator("param", ATTACHMENT_PARAM, validationErrorHook),
	async (c) => {
		const { emailId, attachmentId } = c.req.valid("param");
		const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
		if (!attachment) return apiError(c, 404, "not_found", "Attachment not found");
		const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
		if (!obj) return apiError(c, 404, "not_found", "Attachment file not found");
		const headers = new Headers();
		headers.set("Content-Type", attachment.mimetype);
		const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
		headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
		return new Response(obj.body, { headers });
	},
);
