// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { apiError, validationErrorHook } from "../lib/errors";
import type { MailboxContext } from "../lib/mailbox";
import { ApiErrorSchema, FolderSchema } from "../lib/schemas";

const FOLDER_ID_PARAM = z.object({ mailboxId: z.string(), id: z.string() });

const CreateFolderBody = z.object({
	name: z.string().min(1),
});

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

export const folderRoutes = new Hono<MailboxContext>()
	.get(
		"/api/v1/mailboxes/:mailboxId/folders",
		describeRoute({
			description: "List a mailbox's folders with unread counts.",
			responses: {
				200: {
					description: "Folders",
					content: { "application/json": { schema: resolver(z.array(FolderSchema)) } },
				},
				404: { description: "Mailbox not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		async (c) => c.json(await c.var.mailboxStub.getFolders()),
	)
	.post(
		"/api/v1/mailboxes/:mailboxId/folders",
		describeRoute({
			description: "Create a folder. The id is the slugified name.",
			responses: {
				201: { description: "Created folder", content: { "application/json": { schema: resolver(FolderSchema) } } },
				400: { description: "Invalid name", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				404: { description: "Mailbox not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				409: { description: "Folder already exists", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("json", CreateFolderBody, validationErrorHook),
		async (c) => {
			const { name } = c.req.valid("json");
			const slug = slugify(name);
			if (!slug) return apiError(c, 400, "bad_request", "Folder name must contain alphanumeric characters");
			const f = await c.var.mailboxStub.createFolder(slug, name);
			return f ? c.json(f, 201) : apiError(c, 409, "conflict", "Folder with this name already exists");
		},
	)
	.put(
		"/api/v1/mailboxes/:mailboxId/folders/:id",
		describeRoute({
			description: "Rename a folder.",
			responses: {
				200: { description: "Updated folder", content: { "application/json": { schema: resolver(FolderSchema) } } },
				404: { description: "Folder not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", FOLDER_ID_PARAM, validationErrorHook),
		validator("json", CreateFolderBody, validationErrorHook),
		async (c) => {
			const { name } = c.req.valid("json");
			const f = await c.var.mailboxStub.updateFolder(c.req.valid("param").id, name);
			return f ? c.json(f) : apiError(c, 404, "not_found", "Folder not found");
		},
	)
	.delete(
		"/api/v1/mailboxes/:mailboxId/folders/:id",
		describeRoute({
			description: "Delete a folder. Built-in folders (inbox, sent, draft, archive, trash) cannot be deleted.",
			responses: {
				204: { description: "Deleted" },
				400: { description: "Folder missing or protected", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
				404: { description: "Mailbox not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			},
		}),
		validator("param", FOLDER_ID_PARAM, validationErrorHook),
		async (c) => {
			const ok = await c.var.mailboxStub.deleteFolder(c.req.valid("param").id);
			return ok ? c.body(null, 204) : apiError(c, 400, "bad_request", "Folder not found or cannot be deleted");
		},
	);
