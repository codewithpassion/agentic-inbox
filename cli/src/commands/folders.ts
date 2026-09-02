// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Command } from "commander";
import { getClient, unwrap } from "../client";
import { makeContext, requireMailbox } from "../context";
import { emitList } from "../render";

type Folder = {
	id: string;
	name: string;
	unreadCount: number;
};

/** `inbox folders list`. */
export function registerFolders(program: Command): void {
	const folders = program.command("folders").description("Mailbox folders");

	folders
		.command("list")
		.description("List folders with unread counts")
		.action(async function (this: Command) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const result = await client.GET("/api/v1/mailboxes/{mailboxId}/folders", {
				params: { path: { mailboxId: mailbox } },
			});
			const list = (unwrap(result) as Folder[] | undefined) ?? [];
			emitList(ctx, list, [
				{ header: "ID", cell: (f) => f.id },
				{ header: "NAME", cell: (f) => f.name },
				{ header: "UNREAD", cell: (f) => String(f.unreadCount) },
			]);
		});
}
