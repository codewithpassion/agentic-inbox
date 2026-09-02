# Plan: `inbox` CLI

Goal: a single compiled binary that humans and coding agents can use to drive Agentic Inbox over the REST API from `01-rest-api-plan.md`. The API plan is a hard dependency: the CLI is generated from the OpenAPI spec and authenticates with API keys, so it cannot start before Phase 2 of that plan and cannot finish before Phase 4.

## Decisions to make before starting

### C1. Runtime and build

**Recommendation:** TypeScript on Bun, compiled with `bun build --compile`. One source tree, cross-compiled to `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`. Binaries are around 50 MB because they embed the Bun runtime; that is the trade for zero-install. If size matters more than zero-install, the fallback is publishing to npm and running via `bunx`/`npx`, which the same source supports.

### C2. Where it lives

**Recommendation:** `cli/` in this repo with its own `package.json`, `tsconfig.json`, and `biome.json`. Not an npm workspace (the root uses npm scripts and the CLI uses Bun; mixing them adds friction). The CLI imports nothing from `workers/` or `app/`. Its only link to the server is the generated `cli/src/generated/api.d.ts` from the spec. That keeps it portable: the folder can be copied out and still build.

### C3. Command framework

**Recommendation:** `commander`. Mature, tiny, no runtime tricks that break under `bun build --compile`, and it generates help text that reads well for both humans and models. Input validation with `zod` (already a known quantity in this repo). HTTP via `openapi-fetch` typed by `openapi-typescript` output.

Hono's RPC client (`hc<AppType>`) was considered and rejected (2026-09-02). It would require chained route definitions on the server and a compile-time dependency on the Worker's types, and the OpenAPI spec already gives the CLI a typed client without either.

### C4. Name

`inbox` is short and reads well (`inbox emails list`). It collides with nothing common on PATH. Alternative: `agentic-inbox` as the binary name with `inbox` documented as an alias people create themselves.

## Design principles

The CLI serves two audiences with one interface. The rules below keep it usable for both without flags that change meaning.

**For agents**

- Output is JSON when stdout is not a TTY, or when `--json` is passed. JSON goes to stdout, nothing else does.
- Errors are JSON on stderr in the same envelope the API uses, plus a stable exit code. Never a stack trace.
- No interactive prompts when stdin or stdout is not a TTY. Destructive commands require `--yes` in that case and fail with exit 4 otherwise.
- Every mutating command echoes the id it created or changed, so the next step in a chain has what it needs.
- Long text (email bodies) can be supplied via `--body-file <path>` or `--body -` (stdin), never only as an argument.
- `inbox agent-docs` prints a compact, deterministic description of every command, its flags, and its output shape, sized to fit in a system prompt. This is the thing you paste into an agent's instructions instead of `--help` output for twenty commands.

**For humans**

- Default output on a TTY is a readable table or key-value block. `--format json|table|plain` overrides.
- `inbox auth login` walks through URL and key entry and stores them.
- Destructive commands confirm on a TTY.
- Colour only on a TTY and never when `NO_COLOR` is set.

**Exit codes**

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error (bug, network failure) |
| 2 | Usage error (bad flags, missing argument) |
| 3 | API rejected the request (4xx other than auth) |
| 4 | Confirmation required and not given |
| 5 | Authentication or authorization failure (401, 403) |
| 6 | Not found (404) |

### Configuration precedence

Flags, then environment, then config file.

| Setting | Flag | Env | Config key |
| --- | --- | --- | --- |
| Base URL | `--url` | `INBOX_URL` | `url` |
| API key | `--api-key` | `INBOX_API_KEY` | `api_key` |
| Default mailbox | `--mailbox` | `INBOX_MAILBOX` | `mailbox` |
| Output format | `--format` | `INBOX_FORMAT` | `format` |

Config file: `$XDG_CONFIG_HOME/inbox/config.json`, falling back to `~/.config/inbox/config.json`. Written with mode 0600. Multiple named profiles (`--profile work`) are cheap to support with a `profiles` map and are worth including because one person often runs more than one deployment.

The API key is never printed, including in `auth status`, which shows the prefix only.

## Command tree

Mirrors the API resource by resource. Every command takes `--mailbox` where the route does; it falls back to the configured default.

```
inbox auth login [--url] [--api-key]      # interactive on TTY, flags otherwise
inbox auth status                          # calls GET /me, prints principal and key prefix
inbox auth logout

inbox mailboxes list
inbox mailboxes get <id>

inbox emails list [--folder inbox] [--page 1] [--limit 20] [--threaded]
inbox emails get <emailId> [--raw-headers] [--body-only]
inbox emails search <query> [--folder] [--from] [--to] [--subject]
                             [--after DATE] [--before DATE] [--unread] [--starred] [--has-attachment]
inbox emails send --to <addr> --subject <s> (--body <text> | --body-file <p> | --body -)
                  [--cc] [--bcc] [--html] [--verify] [--attach <path>]...
inbox emails reply <emailId> (--body ...) [--to] [--subject] [--cc] [--bcc] [--verify]
inbox emails forward <emailId> --to <addr> [--body ...]
inbox emails mark-read <emailId>...
inbox emails mark-unread <emailId>...
inbox emails star <emailId> / unstar <emailId>
inbox emails move <emailId>... --folder <folderId>
inbox emails delete <emailId>... [--yes]

inbox threads get <threadId>
inbox threads mark-read <threadId>

inbox drafts create --subject <s> (--body ...) [--to] [--reply-to <emailId>] [--verify]
inbox drafts update <draftId> [--to] [--subject] [--body ...] [--verify]
inbox drafts delete <draftId> [--yes]

inbox folders list
inbox folders create <name>
inbox folders rename <folderId> <name>
inbox folders delete <folderId> [--yes]

inbox attachments download <emailId> <attachmentId> [--out <path>]

inbox agent-docs [--command <name>]       # compact reference for LLM prompts
inbox completions <bash|zsh|fish>
inbox version
```

`--body` is treated as plain text and converted to HTML unless `--html` is passed. `--verify` maps to the `verify` request field from decision D3 in the API plan.

## Implementation notes

- **Generated client.** `bun run gen` runs `openapi-typescript` against `http://localhost:5173/api/v1/openapi.json` (or a checked-in `openapi.json` snapshot) and writes `src/generated/api.d.ts`. `openapi-fetch` uses those types so a route or field rename in the Worker fails the CLI build. Check the generated file into git so the CLI builds without a running server.
- **Module layout.** `src/main.ts` (commander wiring), `src/config.ts`, `src/client.ts` (auth header, base URL, error mapping to exit codes), `src/output.ts` (TTY detection, table/json/plain renderers), `src/commands/<resource>.ts` one file per resource, `src/agent-docs.ts`. Commands only call the client and the renderer. No command file imports another.
- **Body input.** One helper resolves `--body`, `--body-file`, `--body -` into a string and rejects more than one source. Every command that takes a body uses it.
- **Attachments.** `--attach` reads the file, base64 encodes it, and guesses the MIME type from the extension. Size cap matches whatever the API enforces.
- **Tests.** `bun test`. Unit tests for config precedence, exit-code mapping, output mode detection, and body-input resolution. One integration suite runs the built binary against `wrangler dev` with a seeded key and covers list, get, draft, send (to a mailbox on the same domain), move, delete.
- **Release.** GitHub Actions workflow `release-cli.yml` on tag `cli-v*`: `bun install`, `bun test`, one `bun build --compile --target=<t>` per target, upload the five binaries plus `SHA256SUMS` to a GitHub Release. Also provide `install.sh` that picks the right asset for the host and drops it in `~/.local/bin`.
- **In-app hint.** The API keys page from the API plan links to the latest release and shows the two commands to get started:

  ```
  inbox auth login --url https://mail.example.com --api-key aik_...
  inbox mailboxes list
  ```

## Phases

### Phase 0: scaffolding

Requires API plan Phase 2 (keys exist, `GET /me` exists).

1. `cli/` with Bun, biome (strictest ruleset), tsconfig with `noImplicitAny` and `strict`. → Check: `bun run lint` and `bun run typecheck` pass on an empty `main.ts`.
2. Config loading, `auth login|status|logout`. → Check: unit tests for precedence; `auth status` against local dev prints the principal.
3. Output layer with TTY detection and the exit-code map. → Check: `inbox auth status | cat` emits JSON; on a TTY it emits a table.

### Phase 1: read commands

Requires API plan Phase 3 (spec exists, list envelope stable).

1. Generated client from the spec. → Check: generated file committed, `bun run gen` is idempotent.
2. `mailboxes`, `emails list|get|search`, `threads get`, `folders list`, `attachments download`. → Check: integration suite against `wrangler dev`.

### Phase 2: write commands

Requires API plan Phase 4 (parity endpoints).

1. `drafts`, `emails send|reply|forward`, `mark-read|mark-unread|star|unstar|move|delete`, `threads mark-read`, `folders create|rename|delete`. → Check: integration suite; every destructive command refuses without `--yes` when piped.
2. `--verify` and `--attach`. → Check: integration test sends an email with an attachment and reads it back.

### Phase 3: agent and human polish

1. `agent-docs`. → Check: output is under 4,000 tokens for the full tree and is byte-stable between runs.
2. `completions`. → Check: sourcing the bash output completes `inbox emails ` to the subcommands.
3. Release workflow and `install.sh`. → Check: tag a pre-release, install on Linux and macOS from the release, `inbox version` matches the tag.
4. README section and in-app hint. → Check: a fresh machine gets from zero to `inbox emails list` following only the README.

## Risks

- **Spec drift.** If someone changes a route without regenerating, the CLI build fails. That is the intended behaviour, but it needs a line in the README so it does not surprise anyone.
- **Compile-time surprises.** Some npm packages use dynamic `require` that `bun build --compile` cannot bundle. `commander`, `zod`, and `openapi-fetch` are known to work. Anything else gets checked before it is added.
- **Windows.** Config path and TTY detection differ. Build the Windows binary from day one so it does not become a late fix, but treat it as best-effort until someone needs it.
- **Key in shell history.** `auth login --api-key` on the command line lands in history. The interactive path reads it without echo, and the docs recommend `INBOX_API_KEY` for automation.

## Out of scope

- Talking to the MCP server. The CLI uses REST only.
- Running the AI agent from the CLI.
- Watching for new mail (would need a streaming or webhook endpoint that does not exist).
- A TUI.
