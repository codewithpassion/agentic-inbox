// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Command } from "commander";
import { getClient, unwrap } from "../client";
import { makeContext, requireMailbox } from "../context";
import { emitList } from "../render";

type ThreadEmail = {
	id: string;
	subject?: string | null;
	sender?: string | null;
	date?: string | null;
};

/** `inbox threads get`. */
export function registerThreads(program: Command): void {
	const threads = program.command("threads").description("Conversation threads");

	threads
		.command("get <threadId>")
		.description("Show every message in a thread, oldest first")
		.action(async function (this: Command, threadId: string) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const result = await client.GET("/api/v1/mailboxes/{mailboxId}/threads/{threadId}", {
				params: { path: { mailboxId: mailbox, threadId } },
			});
			const messages = (unwrap(result) as ThreadEmail[] | undefined) ?? [];
			emitList(ctx, messages, [
				{ header: "ID", cell: (m) => m.id },
				{ header: "DATE", cell: (m) => m.date ?? "" },
				{ header: "FROM", cell: (m) => m.sender ?? "" },
				{ header: "SUBJECT", cell: (m) => m.subject ?? "" },
			]);
		});
}
