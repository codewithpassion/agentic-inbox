# Current state of the codebase

Analysis done on 2026-09-02 as groundwork for the REST API plan (`01-rest-api-plan.md`) and the CLI plan (`02-cli-plan.md`). Nothing in this document is a proposal. It records what exists and where the gaps are.

## Runtime shape

One Cloudflare Worker (`workers/app.ts`) does everything:

| Concern | Where | Notes |
| --- | --- | --- |
| Auth | `workers/app.ts` middleware on `*` | Validates the `cf-access-jwt-assertion` header with `jose`. Skipped entirely when `import.meta.env.DEV`. Fails closed in production if `POLICY_AUD` or `TEAM_DOMAIN` are missing. |
| MCP server | `workers/mcp/index.ts`, served at `/mcp` | `McpAgent` from the Agents SDK, backed by the `EMAIL_MCP` Durable Object. 13 tools. |
| Internal REST routes | `workers/index.ts`, mounted at `/api/v1` | Hono. Consumed only by the React UI via `app/services/api.ts`. |
| AI agent | `workers/agent/index.ts` at `/agents/*` | `AIChatAgent` over WebSocket, 9 tools, auto-drafts on inbound mail. |
| Mailbox storage | `workers/durableObject/index.ts` | One `MailboxDO` per address, SQLite via Drizzle, migrations in `durableObject/migrations.ts`. |
| Mailbox registry | R2 bucket `BUCKET` | `mailboxes/<email>.json` holds settings. `listMailboxes()` lists the prefix. There is no global database. |
| Attachments | R2 | `attachments/<emailId>/<attId>/<filename>`. |
| Inbound mail | `receiveEmail()` in `workers/index.ts` | Email Routing handler, PostalMime parse, then DO insert and agent trigger. |
| Outbound mail | `workers/email-sender.ts` | `send_email` binding `EMAIL`. |
| UI | `app/` | React Router v7 SSR, TanStack Query, Kumo components. Settings page is per mailbox at `/mailbox/:id/settings`. |

Shared business logic for the agent and the MCP server lives in `workers/lib/tools.ts` (`toolListMailboxes`, `toolListEmails`, `toolGetEmail`, `toolGetThread`, `toolSearchEmails`, `toolDraftReply`, `toolDraftEmail`, `toolUpdateDraft`, `toolDeleteEmail`, `toolSendReply`, `toolSendEmail`, `toolMarkEmailRead`, `toolMoveEmail`, `toolDiscardDraft`). The REST routes in `workers/index.ts` do not use these functions. They call the Durable Object directly and carry their own logic.

## What "no API" means in practice

There is a REST surface at `/api/v1`, but three things stop anyone outside the browser from using it:

1. **Cloudflare Access sits in front of the whole hostname.** The README describes one-click Access on the Worker. Access is enforced at Cloudflare's edge before the Worker runs. A request without an Access session is redirected to the login page. A request with only a custom `Authorization` header never reaches `workers/app.ts`. The Worker's own JWT check is a second line of defence, not the gate.
2. **No credential other than an Access identity exists.** There is no key table, no key UI, no way to mint a token for a script.
3. **The route contracts are loose.** Several handlers cast to `any`, request bodies are read with `as { ... }` instead of validation, and `GET /emails` returns a bare array or an `{ emails, totalCount }` envelope depending on whether `folder` was passed. Fine for a UI you also control, not fine for a public contract.

The MCP server is in the same position: it is reachable only through Access, so an MCP client has to present an Access service token or ride a browser session.

## MCP tools vs. existing REST routes

The user's requirement is that the REST API and the MCP server expose the same functionality. This is the gap list.

| MCP tool | Shared fn | Closest REST route today | Parity gap |
| --- | --- | --- | --- |
| `list_mailboxes` | `toolListMailboxes` | `GET /mailboxes` | REST adds `name`. Otherwise same. |
| `list_emails` | `toolListEmails` | `GET /mailboxes/:id/emails` | REST has more options (`threaded`, `thread_id`, sort). Response shape inconsistent. |
| `get_email` | `toolGetEmail` | `GET /mailboxes/:id/emails/:emailId` | Same. |
| `get_thread` | `toolGetThread` | `GET /mailboxes/:id/threads/:threadId` | Same data. |
| `search_emails` | `toolSearchEmails` | `GET /mailboxes/:id/search` | REST has richer filters and paging. MCP has query + folder only. |
| `draft_reply` | `toolDraftReply` | `POST /mailboxes/:id/drafts` with `in_reply_to` | REST does not append the quoted original and does not run `verifyDraft`. |
| `create_draft` | `toolDraftEmail` | `POST /mailboxes/:id/drafts` | REST does not run `verifyDraft`. |
| `update_draft` | `toolUpdateDraft` | `POST /mailboxes/:id/drafts` with `draft_id` | REST deletes then recreates. Same idea, no `verifyDraft`. |
| `delete_email` | `toolDeleteEmail` | `DELETE /mailboxes/:id/emails/:emailId` | REST also removes R2 attachments. MCP does not. |
| `send_reply` | `toolSendReply` | `POST /mailboxes/:id/emails/:emailId/reply` | REST accepts cc/bcc/attachments and skips `verifyDraft`. |
| `send_email` | `toolSendEmail` | `POST /mailboxes/:id/emails` | REST accepts cc/bcc/attachments/text/html and a `from` display name. Skips `verifyDraft`. Sends asynchronously via `waitUntil` and returns 202. |
| `mark_email_read` | `toolMarkEmailRead` | `PUT /mailboxes/:id/emails/:emailId` | REST also toggles `starred`. |
| `move_email` | `toolMoveEmail` | `POST /mailboxes/:id/emails/:emailId/move` | Same. |

REST-only capabilities with no MCP tool: mailbox create/update/delete, folder CRUD, attachment download, threaded listing, mark whole thread read, forward. These are not gaps in the user's sense, but the plan has to decide whether API keys reach them.

### The `verifyDraft` difference

`workers/lib/ai.ts` `verifyDraft()` sends an outgoing body to Workers AI (`llama-4-scout`) with a prompt that strips prompt-injection artifacts, and falls back to the original on failure or when more than half the text would be removed. Every MCP write path runs it. No UI write path runs it. The stated reason is that agent-generated bodies may carry injected text. This is the single biggest semantic difference between the two surfaces and needs a decision before "identical functionality" can be defined.

## Storage options for API keys

Nothing global and queryable exists today. Candidates, judged against what the repo already uses:

- **Singleton Durable Object with SQLite.** Same pattern as `MailboxDO`, same migration runner, strongly consistent, supports `last_used_at` updates and immediate revocation. Costs one DO round trip per authenticated request (single digit ms). Needs a new class binding and a `wrangler.jsonc` migration tag `v4`.
- **R2.** Already provisioned. Would need a hash-keyed object per key for lookup plus a list prefix for the UI. Updating `last_used_at` means rewriting an object per request. Workable, clumsy.
- **Workers KV.** Fast reads, but eventually consistent, so a revoked key may keep working for up to a minute. Adds a binding the deploy button would have to provision (`package.json` `cloudflare.products`).

## Dependencies relevant to the plans

| Package | Installed | Relevance |
| --- | --- | --- |
| `hono` | 4.12.8 | Router. `@hono/zod-openapi` is compatible but not installed. |
| `zod` | 3.25.76 | Validation. Kumo pins `zod` via an override, so any new zod-dependent package must accept v3. |
| `jose` | 6.2.1 | Access JWT verification. Reusable for cookie-based verification. |
| `agents` | 0.7.6 | MCP server. |
| `drizzle-orm` | 0.45.1 | DO SQLite access. |
| Bun | 1.x on this machine | Not used by the repo today (npm scripts). Candidate for CLI build. |

There are no tests in the repository and no CI workflow.

## Local development

`npm run dev` runs the Vite dev server with the Cloudflare plugin. In dev, the auth middleware returns early, so every route is open on `localhost`. Any new key-based auth has to remain testable in this mode.
