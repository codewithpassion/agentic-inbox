#!/usr/bin/env bun
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `inbox` - CLI for Agentic Inbox over its REST API.
 * Human-readable output on a TTY, deterministic JSON in pipes, stable exit
 * codes for agents. See docs/02-cli-plan.md.
 */
import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerAgentDocs, registerCompletions } from "./agent-docs";
import { ApiError } from "./client";
import { registerAttachments } from "./commands/attachments";
import { registerAuth } from "./commands/auth";
import { registerDrafts } from "./commands/drafts";
import { registerEmails } from "./commands/emails";
import { registerFolders } from "./commands/folders";
import { registerMailboxes } from "./commands/mailboxes";
import { registerThreads } from "./commands/threads";
import { CliError, unexpectedError } from "./errors";
import { ExitCode, printError } from "./output";

export function buildProgram(): Command {
	const program = new Command();
	program
		.name("inbox")
		.description("Drive an Agentic Inbox deployment over its REST API")
		.version(pkg.version)
		.option("--url <url>", "Base URL of the deployment (overrides config and INBOX_URL)")
		.option("--api-key <key>", "API key aik_... (overrides config and INBOX_API_KEY)")
		.option("--mailbox <id>", "Default mailbox for commands that need one")
		.option("--format <format>", "Output format: json, table, or plain")
		.option("--json", "Shorthand for --format json")
		.option("--profile <name>", "Named profile from the config file")
		.option("--yes", "Skip confirmation prompts (destructive commands)");

	registerAuth(program);
	registerMailboxes(program);
	registerEmails(program);
	registerThreads(program);
	registerDrafts(program);
	registerFolders(program);
	registerAttachments(program);
	registerAgentDocs(program);
	registerCompletions(program);
	program
		.command("version")
		.description("Print version")
		.action(() => {
			process.stdout.write(`${pkg.version}\n`);
		});

	return program;
}

/**
 * Run one command and return its exit code instead of exiting the process,
 * so tests (and embedders) can drive the CLI in-process.
 */
export async function runCli(argv: string[]): Promise<number> {
	const program = buildProgram();
	program.exitOverride();
	try {
		await program.parseAsync(argv, { from: "user" });
		return ExitCode.ok;
	} catch (err) {
		if (err instanceof CommanderError) {
			// Help and version output already went to stdout; anything else is
			// a usage error.
			if (err.code === "commander.helpDisplayed" || err.code === "commander.help" || err.code === "commander.version") {
				return ExitCode.ok;
			}
			printError("usage", err.message);
			return ExitCode.usage;
		}
		if (err instanceof ApiError) {
			printError(err.code, err.message);
			return err.exitCode;
		}
		if (err instanceof CliError) {
			printError(err.code, err.message);
			return err.exitCode;
		}
		const fallback = unexpectedError(err);
		printError(fallback.code, fallback.message);
		return ExitCode.unexpected;
	}
}

if (import.meta.main) {
	process.exit(await runCli(process.argv.slice(2)));
}
