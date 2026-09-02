// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * REST API sub-app, mounted at "/" by workers/app.ts.
 *
 * Route groups live in workers/routes/*. Every route is described with
 * hono-openapi (see GET /api/v1/openapi.json) and validates its inputs with
 * zod. Errors use the { error: { code, message } } envelope.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { openAPISpecs } from "hono-openapi";
import PostalMime from "postal-mime";
import { ZodError } from "zod";
import { apiKeyRoutes } from "./apiKeys/routes";
import { attachmentRoutes } from "./routes/attachments";
import { configRoutes } from "./routes/config";
import { draftRoutes } from "./routes/drafts";
import { emailRoutes } from "./routes/emails";
import { folderRoutes } from "./routes/folders";
import { mailboxRoutes } from "./routes/mailboxes";
import { replyForwardRoutes } from "./routes/reply-forward";
import { searchRoutes } from "./routes/search";
import { threadRoutes } from "./routes/threads";
import type { StoredAttachment } from "./lib/attachments";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import { Folders } from "../shared/folders";

const app = new Hono<MailboxContext>();

app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));

// Resolves the mailbox for every /api/v1/mailboxes/:mailboxId/... subroute
// and 404s early when the mailbox does not exist in R2.
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// API key management (Access principals only) and /me
app.route("/", apiKeyRoutes);

// Mail resources
app.route("/", configRoutes);
app.route("/", mailboxRoutes);
app.route("/", emailRoutes);
app.route("/", draftRoutes);
app.route("/", replyForwardRoutes);
app.route("/", threadRoutes);
app.route("/", folderRoutes);
app.route("/", searchRoutes);
app.route("/", attachmentRoutes);

// OpenAPI 3.1 document for the whole surface. The CLI client is generated
// from this spec, so keep it current when routes change.
app.get("/api/v1/openapi.json", openAPISpecs(app, {
	documentation: {
		openapi: "3.1.0",
		info: {
			title: "Agentic Inbox API",
			version: "1.0.0",
			description:
				"REST API for Agentic Inbox. Authenticate with an API key (Authorization: Bearer aik_...) created in the web UI. " +
				"verifyDraft note: the MCP server runs an AI pass over outgoing bodies; the REST API does not by default — pass verify: true on draft and send bodies to opt in.",
		},
	},
}));

// Validation errors become 400s with the standard error envelope; anything
// unexpected is logged and returns 500.
app.onError((err, c) => {
	if (err instanceof ZodError) {
		return c.json(
			{ error: { code: "validation_failed", message: err.issues[0]?.message ?? "Invalid request body" } },
			400,
		);
	}
	console.error("Unhandled API error:", (err as Error).message, (err as Error).stack);
	return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	let mailboxId: string | undefined;
	if (allowedAddresses.length > 0) {
		mailboxId = allRecipients.find((addr) => allowedAddresses.includes(addr));
		if (!mailboxId) { console.log(`Ignoring email: no recipient matches EMAIL_ADDRESSES.`); return; }
	} else { mailboxId = allRecipients[0]; }
	if (!mailboxId) throw new Error("received email with no valid recipient address");

	const messageId = crypto.randomUUID();
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await stub.findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	await stub.createEmail(Folders.INBOX, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, emailId: messageId, sender: (parsedEmail.from?.address || "").toLowerCase(), subject: parsedEmail.subject || "", threadId }),
	})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
}

// Re-exported so the vitest workers pool (whose main module is this file)
// can resolve the Durable Object class names for the test bindings.
export { MailboxDO } from "./durableObject";
export { ApiKeyStore } from "./apiKeys/store";

export { app, receiveEmail };
