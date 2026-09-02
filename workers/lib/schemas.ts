// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared types and Zod schemas for email data.
 *
 * Types (from email-types.ts): used by the agent, MCP server, and route
 * handlers to avoid `as any` casting.
 *
 * Zod schemas: used across route handlers to eliminate duplication.
 */
import { z } from "zod";

// ── TypeScript Interfaces ──────────────────────────────────────────

export interface EmailMetadata {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	folder_id?: string | null;
	snippet?: string | null;
}

export interface EmailFull extends EmailMetadata {
	body?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

// ── Zod Schemas ────────────────────────────────────────────────────

const RecipientFieldSchema = z.union([
	z.string().email(),
	z.array(z.string().email()).min(1),
]);

export const ErrorResponseSchema = z.object({
	error: z.string(),
});

export const SendEmailRequestSchema = z
	.object({
		to: RecipientFieldSchema,
		cc: RecipientFieldSchema.optional(),
		bcc: RecipientFieldSchema.optional(),
		from: z.union([
			z.string().email(),
			z.object({ email: z.string().email(), name: z.string() }),
		]),
		subject: z.string(),
		html: z.string().optional(),
		text: z.string().optional(),
		attachments: z
			.array(
				z.object({
					content: z.string(), // base64 encoded
					filename: z.string(),
					type: z.string(),
					disposition: z.enum(["attachment", "inline"]),
					contentId: z.string().optional(),
				}),
			)
			.optional(),
		in_reply_to: z.string().optional(),
		references: z.array(z.string()).optional(),
		thread_id: z.string().optional(),
		/** Opt in to the AI draft verifier over the outgoing body (D3). */
		verify: z.boolean().optional(),
	})
	.refine((data) => data.html || data.text, {
		message: "Either 'html' or 'text' must be provided",
	});

export const SendEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});

// ── API contract schemas (OpenAPI descriptions) ────────────────────
//
// These describe the public REST surface for GET /api/v1/openapi.json and
// validate request inputs on the routes in workers/routes/*. They are not
// the storage schemas (see workers/db/schema.ts).

export const ApiErrorSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
	}),
});

export const MailboxSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().optional(),
	settings: z.record(z.any()).optional(),
});

export const AttachmentSchema = z.object({
	id: z.string(),
	filename: z.string(),
	mimetype: z.string(),
	size: z.number(),
	content_id: z.string().nullable().optional(),
	disposition: z.string().nullable().optional(),
});

export const EmailSummarySchema = z.object({
	id: z.string(),
	subject: z.string().nullable().optional(),
	sender: z.string().nullable().optional(),
	recipient: z.string().nullable().optional(),
	cc: z.string().nullable().optional(),
	bcc: z.string().nullable().optional(),
	date: z.string().nullable().optional(),
	read: z.boolean(),
	starred: z.boolean(),
	in_reply_to: z.string().nullable().optional(),
	email_references: z.string().nullable().optional(),
	thread_id: z.string().nullable().optional(),
	folder_id: z.string().nullable().optional(),
	snippet: z.string().nullable().optional(),
	// Thread aggregate fields (only present in threaded list view)
	thread_count: z.number().optional(),
	thread_unread_count: z.number().optional(),
	participants: z.string().optional(),
	needs_reply: z.boolean().optional(),
	has_draft: z.boolean().optional(),
});

export const EmailFullSchema = EmailSummarySchema.extend({
	body: z.string().nullable().optional(),
	message_id: z.string().nullable().optional(),
	raw_headers: z.string().nullable().optional(),
	attachments: z.array(AttachmentSchema).optional(),
});

export const EmailListResponseSchema = z.object({
	emails: z.array(EmailSummarySchema),
	totalCount: z.number(),
});

export const FolderSchema = z.object({
	id: z.string(),
	name: z.string(),
	unreadCount: z.number(),
});

export const DraftResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
	subject: z.string(),
	recipient: z.string(),
	date: z.string(),
});

export const SendAcceptedResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});

export const StatusResponseSchema = z.object({
	status: z.string(),
});

// ── Query parameter helpers ────────────────────────────────────────

/** Optional boolean expressed as "true"/"false"/"1"/"0" in the query string. */
export const boolParam = z
	.enum(["true", "false", "1", "0"])
	.optional()
	.transform((v) => (v === undefined ? undefined : v === "true" || v === "1"));

/** Pagination page, coerced and bounded (>= 1). */
export const pageParam = z.coerce.number().int().min(1).optional();

/** Pagination limit, coerced and bounded (1..100, matching the DO caps). */
export const limitParam = z.coerce.number().int().min(1).max(100).optional();
