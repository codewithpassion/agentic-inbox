// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Minimal CLI integration tests: a mock API server plus the real command
 * wiring, verifying exit codes and output shapes for the write paths.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCli } from "../src/main";

const PORT = 5233;
const BASE = `http://localhost:${PORT}`;

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	server = Bun.serve({
		port: PORT,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/drafts/draft-1") && req.method === "PATCH") {
				const body = (await req.json()) as { subject?: string; body?: string };
				return Response.json({
					id: "draft-2",
					status: "draft_updated",
					subject: body.subject ?? "carried over",
					recipient: "carried@example.com",
					date: new Date().toISOString(),
				});
			}
			if (url.pathname.endsWith("/drafts/draft-1") && req.method === "DELETE") {
				return new Response(null, { status: 204 });
			}
			if (url.pathname.endsWith("/emails/email-404") && req.method === "DELETE") {
				return Response.json({ error: { code: "not_found", message: "Email not found" } }, { status: 404 });
			}
			if (url.pathname.includes("/emails/email-ok") && req.method === "DELETE") {
				return new Response(null, { status: 204 });
			}
			return Response.json(
				{ error: { code: "not_found", message: `no route: ${req.method} ${url.pathname}` } },
				{ status: 404 },
			);
		},
	});
});

afterAll(() => server.stop(true));

/** Run one command in-process, capturing stdout and stderr writes. */
async function runCaptured(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = (chunk: unknown) => {
		out.push(String(chunk));
		return true;
	};
	process.stderr.write = (chunk: unknown) => {
		err.push(String(chunk));
		return true;
	};
	try {
		const code = await runCli(args);
		return { code, stdout: out.join(""), stderr: err.join("") };
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
}

describe("CLI write paths against a mock API", () => {
	test("emails delete success exits 0 and echoes the id", async () => {
		const run = await runCaptured([
			"--url",
			BASE,
			"--mailbox",
			"m@example.com",
			"emails",
			"delete",
			"email-ok",
			"--yes",
		]);
		expect(run.code).toBe(0);
		const parsed = JSON.parse(run.stdout) as { id: string; status: string }[];
		expect(parsed).toEqual([{ id: "email-ok", status: "deleted" }]);
	});

	test("emails delete of a missing email exits 6 with the envelope on stderr", async () => {
		const run = await runCaptured([
			"--url",
			BASE,
			"--mailbox",
			"m@example.com",
			"emails",
			"delete",
			"email-404",
			"--yes",
		]);
		expect(run.code).toBe(6);
		const envelope = JSON.parse(run.stderr) as { error: { code: string; message: string } };
		expect(envelope.error.code).toBe("not_found");
		expect(envelope.error.message).toBe("Email not found");
	});

	test("destructive command piped without --yes exits 4 and calls nothing", async () => {
		const run = await runCaptured(["--url", BASE, "--mailbox", "m@example.com", "drafts", "delete", "draft-1"]);
		expect(run.code).toBe(4);
		const envelope = JSON.parse(run.stderr) as { error: { code: string } };
		expect(envelope.error.code).toBe("confirmation_required");
	});

	test("drafts update reports the new id from the recreated draft", async () => {
		const run = await runCaptured([
			"--url",
			BASE,
			"--mailbox",
			"m@example.com",
			"drafts",
			"update",
			"draft-1",
			"--subject",
			"Updated subject",
			"--body",
			"updated body text",
		]);
		expect(run.code).toBe(0);
		const parsed = JSON.parse(run.stdout) as { id: string; status: string }[];
		expect(parsed).toEqual([{ id: "draft-2", status: "draft_updated" }]);
	});
});
