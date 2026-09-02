// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import type { EmailFull } from "./schemas";
import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxes,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
	validateSender,
	SenderValidationError,
} from "./email-helpers";
import { verifyDraft } from "./ai";
import { sendEmail } from "../email-sender";
import { storeAttachments } from "./attachments";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";

/** Base64 attachment as accepted by the send_email binding and R2 storage. */
export interface OutgoingAttachment {
	content: string;
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}

/** Error code so REST routes can map tool failures to status codes. */
export type ToolErrorCode = "bad_request" | "rate_limited" | "not_found" | "verification_failed" | "send_failed";

// ── Type casts for DO methods not on the base stub type ────────────
export type MailboxSearchFilters = {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
};

export type MailboxSearchStub = {
	searchEmails: (options: MailboxSearchFilters & { page?: number; limit?: number }) => Promise<unknown>;
	countSearchResults: (options: MailboxSearchFilters) => Promise<number>;
};

type RateLimitStub = {
	checkSendRateLimit: () => Promise<string | null>;
};

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxes(env.BUCKET);
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.getEmails({
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	});
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(
	env: Env,
	mailboxId: string,
	threadId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	return getFullThread(stub, threadId);
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	return (stub as unknown as MailboxSearchStub).searchEmails({
		query: params.query,
		folder: params.folder,
	});
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, runs AI verifyDraft on the body.
 *   The agent and MCP both do this, but the agent does it on plain text
 *   while MCP does it on HTML.
 */
export async function toolDraftReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
	},
): Promise<
	| { status: "draft_saved"; draftId: string; message: string; draft: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Verify/sanitize if requested
	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	// Convert plain text to HTML if needed
	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Get the original email for thread_id and quoted text
	const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	const threadId = original?.thread_id || params.originalEmailId;

	// Append quoted original message
	const quotedBlock = original
		? buildQuotedReplyBlock({
				date: original.date,
				sender: original.sender || params.to,
				body: original.body ?? undefined,
			})
		: "";
	const bodyHtml = processedBody + quotedBlock;

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: bodyHtml,
			in_reply_to: params.originalEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			originalEmailId: params.originalEmailId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : bodyHtml,
		},
	};
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	env: Env,
	mailboxId: string,
	params: {
		to?: string;
		subject: string;
		body: string;
		cc?: string;
		bcc?: string;
		isPlainText?: boolean;
		/** Run the AI verifier over the draft body. Default false per D3. */
		runVerifyDraft?: boolean;
		/** Optional in_reply_to for create_draft style */
		in_reply_to?: string;
		/** Optional thread_id for create_draft style */
		thread_id?: string;
	},
): Promise<
	| { status: string; draftId: string; date: string; threadId?: string; message: string; draft?: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();
	const date = new Date().toISOString();

	// Resolve thread ID
	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
		resolvedThreadId = original?.thread_id || params.in_reply_to;
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId;
	}

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			cc: params.cc?.toLowerCase() || null,
			bcc: params.bcc?.toLowerCase() || null,
			date,
			body: processedBody,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		date,
		threadId: resolvedThreadId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			to: params.to || "",
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : processedBody,
		},
	};
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	env: Env,
	mailboxId: string,
	params: {
		draftId: string;
		to?: string;
		subject?: string;
		bodyHtml?: string;
		/** Run the AI verifier over the new body (default true, MCP behaviour). */
		runVerifyDraft?: boolean;
	},
): Promise<
	| { status: string; newDraftId: string; oldDraftId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null;
	if (!oldDraft) {
		return { error: "Draft not found" };
	}

	// Verify the body BEFORE deleting the old draft to prevent data loss
	const newDraftId = crypto.randomUUID();
	const rawBody = params.bodyHtml ?? oldDraft.body ?? "";
	const verifiedBody = params.runVerifyDraft === false ? rawBody : await verifyDraft(env.AI, rawBody);

	if (!verifiedBody) {
		return { error: "Draft verification failed — keeping existing draft unchanged. Please try again." };
	}

	await stub.deleteEmail(params.draftId);
	await stub.createEmail(
		Folders.DRAFT,
		{
			id: newDraftId,
			subject: params.subject ?? oldDraft.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to ?? oldDraft.recipient).toLowerCase(),
			cc: oldDraft.cc ?? null,
			bcc: oldDraft.bcc ?? null,
			date: new Date().toISOString(),
			body: verifiedBody,
			in_reply_to: oldDraft.in_reply_to || null,
			email_references: oldDraft.email_references || null,
			thread_id: oldDraft.thread_id || newDraftId,
		},
		[],
	);

	return {
		status: "draft_updated",
		newDraftId,
		oldDraftId: params.draftId,
		message: "Draft updated in Drafts folder.",
	};
}

// ── mark_email_read ────────────────────────────────────────────────

/**
 * Update an email's read flag (and optionally starred, for the REST PUT
 * route which toggles both). Returns the updated email for the REST
 * response, or null when the email does not exist.
 */
export async function toolMarkEmailRead(
	env: Env,
	mailboxId: string,
	emailId: string,
	read: boolean | undefined,
	starred?: boolean,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await stub.updateEmail(emailId, { read, starred });
	return { status: "updated", emailId, read: read ?? false, email };
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	folderId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const success = await stub.moveEmail(emailId, folderId);
	if (success) {
		return { status: "moved", emailId, folder: folderId };
	}
	return { error: "Failed to move email" };
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(
	env: Env,
	mailboxId: string,
	draftId: string,
): Promise<{ status: "discarded"; draftId: string } | { error: string }> {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(draftId)) as { folder_id?: string } | null;
	if (!email) {
		return { error: "Draft not found" };
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" };
	}
	await stub.deleteEmail(draftId);
	return { status: "discarded", draftId };
}

// ── delete_email ───────────────────────────────────────────────────

/**
 * Delete an email. The REST route passes `bucket` so attachment blobs are
 * removed from R2 as well; MCP keeps its historical behaviour of only
 * deleting the DO row.
 */
export async function toolDeleteEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	bucket?: R2Bucket,
): Promise<{ status: "deleted"; emailId: string } | { error: string; emailId: string }> {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.deleteEmail(emailId);
	if (result === null) {
		return { error: "Email not found", emailId };
	}
	if (bucket && result.length > 0) {
		await bucket.delete(result.map((att) => `attachments/${emailId}/${att.id}/${att.filename}`));
	}
	return { status: "deleted", emailId };
}

// ── send_reply ─────────────────────────────────────────────────────

/**
 * Send a reply to an email, shared by MCP and the REST reply route.
 *
 * @param params.verify - Run the AI verifier over the outgoing body.
 *   Default false per decision D3; the MCP server passes true.
 * @param params.appendQuoted - Append the quoted original block to the HTML
 *   body. Default true; the REST route passes false because the composer
 *   already includes quoted text.
 * @param params.markThreadRead - Mark the thread read after storing. The
 *   REST route passes true (matching the UI flow).
 * @param params.deferDelivery - When given, delivery is deferred via
 *   waitUntil (REST returns 202 before delivery completes).
 */
export async function toolSendReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string | string[];
		from?: string | { email: string; name: string };
		cc?: string | string[];
		bcc?: string | string[];
		subject: string;
		bodyHtml?: string;
		text?: string;
		attachments?: OutgoingAttachment[];
		verify?: boolean;
		appendQuoted?: boolean;
		markThreadRead?: boolean;
		deferDelivery?: { waitUntil: (promise: Promise<unknown>) => void };
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string; code?: ToolErrorCode }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError, code: "rate_limited" };
	}

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!originalEmail) {
		return { error: "Original email not found", code: "not_found" };
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(params.to, params.from ?? mailboxId, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return { error: e.message, code: "bad_request" };
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	let body = params.bodyHtml || params.text || "";
	if (params.verify) {
		const sanitized = await verifyDraft(env.AI, body);
		if (!sanitized) {
			return { error: "Draft verification failed — refusing to send unverified content. Please try again.", code: "verification_failed" };
		}
		body = sanitized;
	}
	if (params.appendQuoted !== false && params.bodyHtml) {
		body += buildQuotedReplyBlock({
			date: originalEmail.date,
			sender: originalEmail.sender || toStr,
			body: originalEmail.body ?? undefined,
		});
	}

	const attachmentData = await storeAttachments(env.BUCKET, messageId, params.attachments);

	const ccStr = params.cc ? (Array.isArray(params.cc) ? params.cc.join(", ") : params.cc).toLowerCase() : null;
	const bccStr = params.bcc ? (Array.isArray(params.bcc) ? params.bcc.join(", ") : params.bcc).toLowerCase() : null;

	const sentEmail = {
		id: messageId,
		subject: params.subject,
		sender: fromEmail,
		recipient: toStr,
		cc: ccStr,
		bcc: bccStr,
		date: new Date().toISOString(),
		body,
		in_reply_to: originalMsgId,
		email_references: references.length > 0 ? JSON.stringify(references) : null,
		thread_id: threadId,
		message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof (params.from ?? mailboxId) === "string" ? (params.from ?? mailboxId) as string : `${(params.from as { email: string; name: string }).name} <${(params.from as { email: string; name: string }).email}>` },
			{ key: "to", value: Array.isArray(params.to) ? params.to.join(", ") : params.to },
			...(ccStr ? [{ key: "cc", value: Array.isArray(params.cc) ? params.cc.join(", ") : params.cc }] : []),
			...(bccStr ? [{ key: "bcc", value: Array.isArray(params.bcc) ? params.bcc.join(", ") : params.bcc }] : []),
			{ key: "subject", value: params.subject },
			{ key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
			...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
			...(references.length > 0 ? [{ key: "references", value: references.map((r) => `<${r}>`).join(" ") }] : []),
		]),
	};

	const deliver = () =>
		sendEmail(env.EMAIL, {
			to: params.to,
			cc: params.cc,
			bcc: params.bcc,
			from: params.from ?? mailboxId,
			subject: params.subject,
			html: params.bodyHtml ? body : undefined,
			text: params.text && !params.bodyHtml ? body : undefined,
			attachments: params.attachments,
			headers: buildThreadingHeaders(originalMsgId, references),
		});

	if (params.deferDelivery) {
		await stub.createEmail(Folders.SENT, sentEmail, attachmentData);
		params.deferDelivery.waitUntil(
			deliver().catch((e) => console.error("Deferred reply delivery failed:", (e as Error).message)),
		);
	} else {
		try {
			await deliver();
		} catch (e) {
			console.error("Email send failed:", (e as Error).message);
			return { error: `Failed to send reply: ${(e as Error).message}`, code: "send_failed" };
		}
		await stub.createEmail(Folders.SENT, sentEmail, attachmentData);
	}

	if (params.markThreadRead) {
		await stub.markThreadRead(threadId);
	}

	return { status: "sent", messageId, message: `Reply sent to ${toStr}` };
}

// ── send_email ─────────────────────────────────────────────────────

/**
 * Send a new email, shared by MCP and the REST send route.
 * See toolSendReply for the verify / deferDelivery options.
 */
export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string | string[];
		from?: string | { email: string; name: string };
		cc?: string | string[];
		bcc?: string | string[];
		subject: string;
		html?: string;
		text?: string;
		attachments?: OutgoingAttachment[];
		in_reply_to?: string;
		references?: string[];
		thread_id?: string;
		verify?: boolean;
		deferDelivery?: { waitUntil: (promise: Promise<unknown>) => void };
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string; code?: ToolErrorCode }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError, code: "rate_limited" };
	}

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(params.to, params.from ?? mailboxId, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return { error: e.message, code: "bad_request" };
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const body = params.html || params.text || "";
	let finalBody = body;
	if (params.verify) {
		const sanitized = await verifyDraft(env.AI, body);
		if (!sanitized) {
			return { error: "Draft verification failed — refusing to send unverified content. Please try again.", code: "verification_failed" };
		}
		finalBody = sanitized;
	}

	const attachmentData = await storeAttachments(env.BUCKET, messageId, params.attachments);

	const ccStr = params.cc ? (Array.isArray(params.cc) ? params.cc.join(", ") : params.cc).toLowerCase() : null;
	const bccStr = params.bcc ? (Array.isArray(params.bcc) ? params.bcc.join(", ") : params.bcc).toLowerCase() : null;

	const sentEmail = {
		id: messageId,
		subject: params.subject,
		sender: fromEmail,
		recipient: toStr,
		cc: ccStr,
		bcc: bccStr,
		date: new Date().toISOString(),
		body: finalBody,
		in_reply_to: params.in_reply_to || null,
		email_references: params.references ? JSON.stringify(params.references) : null,
		thread_id: params.thread_id || params.in_reply_to || messageId,
		message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof (params.from ?? mailboxId) === "string" ? (params.from ?? mailboxId) as string : `${(params.from as { email: string; name: string }).name} <${(params.from as { email: string; name: string }).email}>` },
			{ key: "to", value: Array.isArray(params.to) ? params.to.join(", ") : params.to },
			...(ccStr ? [{ key: "cc", value: Array.isArray(params.cc) ? params.cc.join(", ") : params.cc }] : []),
			...(bccStr ? [{ key: "bcc", value: Array.isArray(params.bcc) ? params.bcc.join(", ") : params.bcc }] : []),
			{ key: "subject", value: params.subject },
			{ key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	};

	const deliver = () =>
		sendEmail(env.EMAIL, {
			to: params.to,
			cc: params.cc,
			bcc: params.bcc,
			from: params.from ?? mailboxId,
			subject: params.subject,
			html: params.html,
			text: params.text,
			attachments: params.attachments,
			...(params.in_reply_to
				? { headers: buildThreadingHeaders(params.in_reply_to, params.references || []) }
				: {}),
		});

	if (params.deferDelivery) {
		await stub.createEmail(Folders.SENT, sentEmail, attachmentData);
		params.deferDelivery.waitUntil(
			deliver().catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
		);
	} else {
		try {
			await deliver();
		} catch (e) {
			console.error("Email send failed:", (e as Error).message);
			return { error: `Failed to send email: ${(e as Error).message}`, code: "send_failed" };
		}
		await stub.createEmail(Folders.SENT, sentEmail, attachmentData);
	}

	return { status: "sent", messageId, message: `Email sent to ${toStr}` };
}
