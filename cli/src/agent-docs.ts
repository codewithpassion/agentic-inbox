// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Command } from "commander";
import { printJson } from "./output";

/**
 * Compact, deterministic description of the command tree, sized for a
 * system prompt. Byte-stable between runs: only literal strings below.
 */

interface CommandDoc {
	name: string;
	args?: string;
	flags: string[];
	description: string;
}

interface GroupDoc {
	name: string;
	description: string;
	commands: CommandDoc[];
}

const GLOBAL_FLAGS = [
	"--url <url>",
	"--api-key <key>",
	"--mailbox <id>",
	"--format json|table|plain",
	"--json",
	"--profile <name>",
	"--yes",
];

const GROUPS: GroupDoc[] = [
	{
		name: "auth",
		description: "Credentials and connection",
		commands: [
			{
				name: "login",
				flags: ["--url <url>", "--api-key <key>"],
				description: "Store the base URL and API key for a profile",
			},
			{
				name: "status",
				flags: [],
				description: "Print the active profile, url, and the principal the credentials resolve to",
			},
			{ name: "profiles", flags: [], description: "List the profiles the config file defines" },
			{ name: "logout", flags: [], description: "Remove the stored API key for a profile" },
		],
	},
	{
		name: "mailboxes",
		description: "Mailbox administration",
		commands: [
			{ name: "list", flags: [], description: "List mailboxes" },
			{ name: "get", args: "<id>", flags: [], description: "Show one mailbox" },
		],
	},
	{
		name: "emails",
		description: "Read and manage emails",
		commands: [
			{
				name: "list",
				flags: ["--folder <name>", "--page <n>", "--limit <n>", "--threaded"],
				description: "List emails; default folder inbox",
			},
			{ name: "get", args: "<emailId>", flags: ["--raw-headers", "--body-only"], description: "Show one email" },
			{
				name: "search",
				args: "<query>",
				flags: [
					"--folder <name>",
					"--from <addr>",
					"--to <addr>",
					"--subject <text>",
					"--after <date>",
					"--before <date>",
					"--unread",
					"--starred",
					"--has-attachment",
					"--page <n>",
					"--limit <n>",
				],
				description: "Search emails",
			},
			{
				name: "send",
				flags: [
					"--to <addr>",
					"--subject <text>",
					"--cc <addr>",
					"--bcc <addr>",
					"--body <text>",
					"--body-file <path>",
					"--html",
					"--verify",
					"--attach <path>",
				],
				description: "Send a new email; --body - reads stdin",
			},
			{
				name: "reply",
				args: "<emailId>",
				flags: [
					"--to <addr>",
					"--subject <text>",
					"--cc <addr>",
					"--bcc <addr>",
					"--body <text>",
					"--body-file <path>",
					"--html",
					"--verify",
				],
				description: "Send a reply; threading from the original",
			},
			{
				name: "forward",
				args: "<emailId>",
				flags: [
					"--to <addr>",
					"--subject <text>",
					"--cc <addr>",
					"--bcc <addr>",
					"--body <text>",
					"--body-file <path>",
					"--html",
					"--verify",
				],
				description: "Forward an email",
			},
			{ name: "mark-read", args: "<emailId...>", flags: [], description: "Mark emails read" },
			{ name: "mark-unread", args: "<emailId...>", flags: [], description: "Mark emails unread" },
			{ name: "star", args: "<emailId...>", flags: [], description: "Star emails" },
			{ name: "unstar", args: "<emailId...>", flags: [], description: "Unstar emails" },
			{ name: "move", args: "<emailId...>", flags: ["--folder <id>"], description: "Move emails to a folder" },
			{ name: "delete", args: "<emailId...>", flags: ["--yes"], description: "Delete emails permanently" },
		],
	},
	{
		name: "threads",
		description: "Conversation threads",
		commands: [
			{ name: "get", args: "<threadId>", flags: [], description: "Show every message in a thread" },
			{ name: "mark-read", args: "<threadId>", flags: [], description: "Mark a thread read" },
		],
	},
	{
		name: "drafts",
		description: "Draft management",
		commands: [
			{
				name: "create",
				flags: [
					"--to <addr>",
					"--subject <text>",
					"--body <text>",
					"--body-file <path>",
					"--reply-to <emailId>",
					"--verify",
				],
				description: "Save a draft (not sent)",
			},
			{
				name: "update",
				args: "<draftId>",
				flags: ["--to <addr>", "--subject <text>", "--body <text>", "--body-file <path>", "--verify"],
				description: "Update a draft; the id changes",
			},
			{ name: "delete", args: "<draftId>", flags: ["--yes"], description: "Discard a draft" },
		],
	},
	{
		name: "folders",
		description: "Mailbox folders",
		commands: [
			{ name: "list", flags: [], description: "List folders with unread counts" },
			{ name: "create", args: "<name>", flags: [], description: "Create a folder" },
			{ name: "rename", args: "<folderId> <name>", flags: [], description: "Rename a folder" },
			{ name: "delete", args: "<folderId>", flags: ["--yes"], description: "Delete a folder" },
		],
	},
	{
		name: "attachments",
		description: "Attachment files",
		commands: [
			{
				name: "download",
				args: "<emailId> <attachmentId>",
				flags: ["--out <path>"],
				description: "Download an attachment",
			},
		],
	},
];

const EXIT_CODES = "exit codes: 0 ok, 1 unexpected, 2 usage, 3 API 4xx, 4 confirmation required, 5 auth, 6 not found";

function renderDocs(groups: GroupDoc[]): string {
	const lines: string[] = [
		"inbox - CLI for Agentic Inbox (REST API, authenticated with an API key)",
		"global flags:",
		...GLOBAL_FLAGS.map((f) => `  ${f}`),
		"output: JSON on stdout when piped or --json; tables on a TTY",
		EXIT_CODES,
		"",
	];
	for (const group of groups) {
		lines.push(`${group.name} - ${group.description}`);
		for (const cmd of group.commands) {
			const args = cmd.args ? ` ${cmd.args}` : "";
			const flags = cmd.flags.length > 0 ? ` [${cmd.flags.join(" ")}]` : "";
			lines.push(`  inbox ${group.name} ${cmd.name}${args}${flags}`);
			lines.push(`      ${cmd.description}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

/** Register `inbox agent-docs` and `inbox completions`. */
export function registerAgentDocs(program: Command): void {
	program
		.command("agent-docs")
		.description("Print a compact, deterministic command reference for LLM prompts")
		.option("--command <name>", "Only the named group (e.g. emails)")
		.action(async function (this: Command) {
			// --json is a global flag; a local --json would never fire because
			// Commander resolves the parent's flag first.
			const opts = this.optsWithGlobals() as { command?: string; json?: boolean };
			const groups = opts.command ? GROUPS.filter((g) => g.name === opts.command) : GROUPS;
			if (groups.length === 0) {
				process.stderr.write(`unknown command group: ${opts.command}\n`);
				process.exitCode = 2;
				return;
			}
			if (opts.json) {
				printJson({ global_flags: GLOBAL_FLAGS, exit_codes: EXIT_CODES, groups });
				return;
			}
			process.stdout.write(renderDocs(groups));
		});
}

/** Register `inbox completions` (bash/zsh/fish). */
export function registerCompletions(program: Command): void {
	program
		.command("completions <shell>")
		.description("Print shell completion script: bash, zsh, or fish")
		.action((shell: string) => {
			const script = COMPLETIONS[shell];
			if (!script) {
				process.stderr.write(`unknown shell "${shell}": use bash, zsh, or fish\n`);
				process.exitCode = 2;
				return;
			}
			process.stdout.write(script);
		});
}

const COMPLETIONS: Record<string, string> = {
	bash: `_inbox_completions() {
	local cur="\${COMP_WORDS[COMP_CWORD]}"
	local words="auth mailboxes emails threads drafts folders attachments agent-docs completions version help"
	if [ "$COMP_CWORD" -eq 1 ]; then
		COMPREPLY=( $(compgen -W "$words" -- "$cur") )
	else
		local prev="\${COMP_WORDS[COMP_CWORD - 1]}"
		local sub="\${COMP_WORDS[1]}"
		local subwords=""
		case "$sub" in
			auth) subwords="login status logout" ;;
			mailboxes) subwords="list get" ;;
			emails) subwords="list get search send reply forward mark-read mark-unread star unstar move delete" ;;
			threads) subwords="get mark-read" ;;
			drafts) subwords="create update delete" ;;
			folders) subwords="list create rename delete" ;;
			attachments) subwords="download" ;;
		esac
		COMPREPLY=( $(compgen -W "$subwords" -- "$cur") )
	fi
}
complete -F _inbox_completions inbox
`,
	zsh: `#compdef inbox
_inbox() {
	local -a commands
	commands=(
		'auth:Credentials and connection'
		'mailboxes:Mailbox administration'
		'emails:Read and manage emails'
		'threads:Conversation threads'
		'drafts:Draft management'
		'folders:Mailbox folders'
		'attachments:Attachment files'
		'agent-docs:Command reference for LLM prompts'
		'completions:Shell completion scripts'
		'version:Print version'
	)
	_describe 'command' commands
}
compdef _inbox inbox
`,
	fish: `complete -c inbox -n '__fish_use_subcommand' -a auth -d 'Credentials and connection'
complete -c inbox -n '__fish_use_subcommand' -a mailboxes -d 'Mailbox administration'
complete -c inbox -n '__fish_use_subcommand' -a emails -d 'Read and manage emails'
complete -c inbox -n '__fish_use_subcommand' -a threads -d 'Conversation threads'
complete -c inbox -n '__fish_use_subcommand' -a drafts -d 'Draft management'
complete -c inbox -n '__fish_use_subcommand' -a folders -d 'Mailbox folders'
complete -c inbox -n '__fish_use_subcommand' -a attachments -d 'Attachment files'
complete -c inbox -n '__fish_use_subcommand' -a agent-docs -d 'Command reference for LLM prompts'
complete -c inbox -n '__fish_seen_subcommand_from auth' -a 'login status logout'
complete -c inbox -n '__fish_seen_subcommand_from mailboxes' -a 'list get'
complete -c inbox -n '__fish_seen_subcommand_from emails' -a 'list get search send reply forward mark-read mark-unread star unstar move delete'
complete -c inbox -n '__fish_seen_subcommand_from threads' -a 'get mark-read'
complete -c inbox -n '__fish_seen_subcommand_from drafts' -a 'create update delete'
complete -c inbox -n '__fish_seen_subcommand_from folders' -a 'list create rename delete'
complete -c inbox -n '__fish_seen_subcommand_from attachments' -a 'download'
`,
};
