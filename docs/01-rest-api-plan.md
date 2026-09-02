# Plan: REST API with API-key authentication

Goal: let scripts, agents, and the CLI call Agentic Inbox over HTTP with an API key that a signed-in human creates, renames, revokes, or deletes in the web UI. Functionality matches the MCP server. Only the authentication differs.

Read `00-current-state.md` first. This plan builds on its gap list.

## Decisions to make before starting

These change the shape of the work. Each has a recommendation. Nothing below is implemented until these are confirmed.

### D1. How key-authenticated requests get past Cloudflare Access

Access runs at the edge, before the Worker. A request with only `Authorization: Bearer <key>` is blocked before any Worker code runs. Something has to change in the Access configuration, not just in code.

**Option A (recommended): path-scoped Access application with a Bypass policy.**
Create a self-hosted Access application whose domain is `mail.example.com/api/v1/*` (and `mail.example.com/mcp*` if D5 is accepted) with a single policy of action Bypass, include Everyone. Confirm the wildcard syntax against the Access "Application paths" docs before creating it. If the path matches exactly rather than as a prefix, `/api/v1/mailboxes` stays behind Access and the Phase 5 curl check fails for a reason that looks like a code bug. Cloudflare applies the most specific matching application, so the path rule wins over the Worker-level rule. The Worker becomes the only gate on `/api/v1/*`.

Consequence that must be handled in code: under Bypass, Access no longer injects `cf-access-jwt-assertion`. The browser still sends the `CF_Authorization` cookie, which Access sets on the protected hostname and which is domain-scoped by default (the Cookie Path Attribute setting must stay off). The Worker therefore verifies the JWT from the cookie when the header is missing. Same `jose` call, same issuer and audience. Without this, the UI breaks the moment the bypass is created.

Pros: one base URL for UI, API, and CLI. No DNS work. One deployment.
Cons: `/api/v1/*` is reachable from the public internet, gated only by Worker code. That is the normal posture for any public API, but it makes the auth middleware load-bearing, so it gets tests.

**Option B: second custom domain for the API.**
Add `api.mail.example.com` as a second `custom_domain` route in `wrangler.jsonc`. Do not put an Access application on it. The Worker chooses auth mode by `Host`: Access JWT on the UI host, API key on the API host.

Pros: zero change to how the UI is protected. Clean separation.
Cons: a second hostname to configure and document, CLI config points somewhere different from the UI, and the API-key management endpoints (which need an Access identity) still have to live on the UI host.

**Not viable:** Access Service Tokens. They work for machine clients, but they are created in the Zero Trust dashboard, not in this app's UI, which is what was asked for.

Both options need a manual step in the Cloudflare dashboard (or a Terraform/API call) that this repo cannot perform. The README gets a section for it.

### D2. What "the API" is

**Recommendation:** the existing `/api/v1` routes, hardened, with dual authentication, plus new endpoints to close the MCP parity gaps. Not a second API alongside.

Reasoning: `/api/v1` is already a superset of the MCP tools, the UI proves the routes work, and a second surface would mean two contracts to keep in sync. The cost is that hardening touches every existing handler and the UI client in `app/services/api.ts`.

### D3. Whether `verifyDraft` runs on key-authenticated writes

MCP runs an AI pass over every outgoing body. The UI does not.

**Recommendation:** do not run it on REST by default. Add an opt-in `verify: true` field on draft and send bodies, and have the CLI expose it as `--verify`. Reasons: a human on the CLI would not expect their text to be rewritten by a model; `verifyDraft` adds an AI call and latency to every send; and the guardrail belongs to the caller that generated the text, which for the REST API is not this Worker. The MCP server keeps its current behaviour. Document the difference in the OpenAPI description.

If the user prefers strict parity, the alternative is: run `verifyDraft` whenever the principal is an API key, skip it for Access principals. One conditional in the shared write path. Either is a small change; the plan just needs the answer.

### D4. Key scope

**Recommendation:** ship global keys first (a key can do what the UI can do, matching the existing trust model where anyone through Access sees every mailbox). Include an optional `mailboxes` restriction as a nullable JSON column and a multi-select in the create dialog. Cost is one column, one check in `requireMailbox`, and one form field. Value is least privilege for agents, which is the main consumer.

If dropped, the schema still leaves room for it later.

### D5. Whether API keys also authenticate `/mcp`

Not asked for. The MCP server stays as-is. Listed because the auth middleware is shared, so accepting `Authorization: Bearer <key>` on `/mcp` is nearly free and would let Claude Code or Cursor connect without an Access service token. Recommended as an optional last step.

### D6. Key storage

**Recommendation:** a singleton Durable Object `ApiKeyStore` (id from name `"global"`) with SQLite, reusing `applyMigrations` from `workers/durableObject/migrations.ts`. Matches the codebase, immediate revocation, cheap `last_used_at` updates. Adds a DO class binding `API_KEYS` and migration tag `v4` in `wrangler.jsonc`. No new product to provision for the deploy button.

R2 and KV were considered and rejected in `00-current-state.md`.

## Design

### Key format and storage

- Plaintext key: `aik_` + 32 random bytes, base64url. The prefix makes keys greppable in leaked logs and lets the middleware skip Access-JWT parsing when it sees one.
- Stored: SHA-256 of the plaintext. Plaintext is returned exactly once, in the create response.
- Display: `key_prefix`, the first 12 characters (`aik_` plus 8), so the UI and CLI can show which key is which.

Table `api_keys` in the `ApiKeyStore` DO:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text pk | UUID |
| `name` | text not null | Editable |
| `key_prefix` | text not null | For display |
| `key_hash` | text not null unique | SHA-256 hex, indexed |
| `mailboxes` | text null | JSON array of mailbox ids, null means all (D4) |
| `created_at` | text not null | ISO |
| `created_by` | text null | Access email from the JWT `email` claim |
| `expires_at` | text null | ISO, optional |
| `last_used_at` | text null | Updated at most once per minute per key to avoid a write per request |
| `revoked_at` | text null | Soft revoke |

DO methods: `create`, `list`, `get`, `rename`, `revoke`, `delete`, `verify(hash)`. `verify` returns the row only if not revoked and not expired, and updates `last_used_at` with the throttle above.

### Authentication middleware

Replace the single `app.use("*")` block in `workers/app.ts` with one middleware that resolves a **principal** and stores it on the Hono context:

```ts
type Principal =
  | { kind: "access"; email: string }
  | { kind: "api_key"; keyId: string; name: string; mailboxes: string[] | null }
  | { kind: "dev" };
```

Resolution order:

1. `Authorization: Bearer aik_...` present: hash, look up in `ApiKeyStore`, reject with 401 if unknown, revoked, or expired. Runs in dev too, so the CLI can be tested against `localhost`.
2. Otherwise `cf-access-jwt-assertion` header, else `CF_Authorization` cookie: verify with `jose` as today. Extract `email`.
3. Otherwise in dev: principal `dev`.
4. Otherwise: 401 for `/api/*` (JSON body), 403 text for everything else (unchanged behaviour for the SPA).

Authorization rules layered on top:

- `/api/v1/api-keys/*` requires `kind === "access"` or `dev`. A key can never manage keys. Returns 403 otherwise.
- `requireMailbox` additionally checks `principal.mailboxes` when set (D4). Returns 404, not 403, so a scoped key cannot enumerate mailboxes it cannot see. `GET /mailboxes` filters the list the same way.
- `/agents/*` (WebSocket agent) stays Access-only. Not part of the API.

### API-key management endpoints

All under `/api/v1/api-keys`, Access principal only.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api-keys` | | `{ keys: ApiKey[] }`, never includes hash or plaintext |
| POST | `/api-keys` | `{ name, expires_at?, mailboxes? }` | 201 `{ key: ApiKey, secret: "aik_..." }` |
| PATCH | `/api-keys/:id` | `{ name?, expires_at?, mailboxes? }` | `{ key }` |
| POST | `/api-keys/:id/revoke` | | `{ key }` with `revoked_at` set |
| DELETE | `/api-keys/:id` | | 204 |

`GET /api/v1/me` returns the resolved principal (minus secrets). The CLI uses it for `auth status`.

### Hardening the existing routes

Do this resource by resource, updating `app/services/api.ts` and the affected `app/queries/*` hooks in the same commit so the UI never breaks.

- Move the API router to `OpenAPIHono` from `@hono/zod-openapi` (works with the installed zod 3.25 and hono 4.12). Each route gets a `createRoute` with request and response schemas. This replaces every `as any` and `as { ... }` cast, and produces `GET /api/v1/openapi.json` for free. `hono-openapi` is the lighter alternative if the rewrite feels too large; it keeps handlers as they are and adds `describeRoute` wrappers.
- Error envelope everywhere: `{ error: { code: string, message: string } }` with codes like `not_found`, `validation_failed`, `unauthorized`, `forbidden`, `rate_limited`, `send_failed`. Today errors are `{ error: string }`. The UI's `ApiError` class reads `body.error`, so it changes to read `body.error.message`.
- `GET /mailboxes/:id/emails` always returns `{ emails, totalCount }`. The UI already handles both shapes, so this is a pure simplification.
- Pagination inputs validated: `page >= 1`, `1 <= limit <= 100`.
- Route the write paths through `workers/lib/tools.ts` where a tool function exists, so REST and MCP share the same code. Where REST is richer (cc, bcc, attachments), extend the tool function with optional parameters rather than keeping two copies. `verifyDraft` becomes a parameter on those functions (it already is for drafts), defaulting per D3.

### Parity endpoints to add

| Purpose | Route | Shared fn |
| --- | --- | --- |
| Draft a reply with quoted original | `POST /mailboxes/:id/emails/:emailId/draft-reply` | `toolDraftReply` |
| Update a draft in place | `PATCH /mailboxes/:id/drafts/:draftId` | `toolUpdateDraft` |
| Discard a draft | `DELETE /mailboxes/:id/drafts/:draftId` | `toolDiscardDraft` |
| Mark read/unread only | already `PUT /emails/:emailId` with `{ read }` | `toolMarkEmailRead` |

Everything else in the MCP tool list already has a REST route.

### Rate limiting

`MailboxDO.checkSendRateLimit()` already throttles sends per mailbox. Keep it. Add nothing else for now; brute-forcing a 256-bit key is not a practical threat and the auth check is a single hash plus a DO read.

### UI

- New global route `/settings/api-keys` in `app/routes.ts` (settings today is per mailbox, keys are not). Link from the header account area and from the mailbox settings page.
- Page: table of keys with name, prefix, created, last used, expires, status badge (active, expired, revoked). Row actions: rename, revoke, delete. Header action: create.
- Create dialog: name, optional expiry, optional mailbox multi-select (D4). On success, a second step shows the plaintext key once with a copy button and the warning that it will not be shown again. Reuse `CopyButton` from `MCPPanel.tsx` by moving it to `app/components/`.
- Revoke and delete each confirm in a dialog. Revoke is reversible in spirit (the record stays and shows why a client stopped working); delete is not.
- Hooks in `app/queries/api-keys.ts` following the `mailboxes.ts` pattern. Client functions added to `app/services/api.ts`.
- `MCPPanel.tsx` gets a short "REST API and CLI" block: base URL, link to `/api/v1/openapi.json`, link to the API keys page.

### Configuration and docs

- `wrangler.jsonc`: `API_KEYS` DO binding, migration `v4` with `new_sqlite_classes: ["ApiKeyStore"]`.
- `README.md`: new "API access" section covering D1 setup steps in the dashboard, key creation, a curl example, and the `verifyDraft` note.
- `workers/types.ts`: `Env` gains `API_KEYS`. Run `npm run cf-typegen` after the wrangler change.

## Phases

Each step names its check. Do not start the next step until the check passes.

### Phase 0: prerequisites (no code)

1. Confirm the deployed Access setup is one-click Worker-level Access. → Check: dashboard shows the Worker under Workers & Pages > Access.
2. Decide D1 through D6. → Check: decisions recorded at the top of this file.
3. Add a test harness: `vitest` with `@cloudflare/vitest-pool-workers`, one smoke test that mounts the Hono sub-app exported from `workers/index.ts` and hits `/api/v1/config`. Test that export, not `workers/app.ts`, because the entry imports `virtual:react-router/server-build`, which the test pool may not resolve. → Check: `npm test` passes. Nothing else in this plan is verifiable without it.

### Phase 1: key store and auth middleware

1. `workers/apiKeys/store.ts`: `ApiKeyStore` DO, migration, methods listed above. → Check: unit tests for create, verify (valid, revoked, expired, unknown), revoke, delete, `last_used_at` throttle.
2. `workers/lib/auth.ts`: principal resolution middleware, cookie fallback, dev behaviour. → Check: tests for each branch in the resolution order, including "key present in dev is still validated".
3. Wire into `workers/app.ts`, replacing the current block. → Check: existing UI flows work locally with no header (dev principal), and a request with a bogus Bearer key gets 401 JSON.
4. `wrangler.jsonc` and `Env` updates. → Check: `npm run typecheck` passes.

### Phase 2: key management API and UI

1. Management routes under `/api/v1/api-keys` plus `GET /me`, Access-only. → Check: tests show a key principal gets 403 on every management route.
2. `app/services/api.ts` and `app/queries/api-keys.ts`. → Check: typecheck.
3. `/settings/api-keys` page with create, rename, revoke, delete, and the show-once secret step. → Check: manual walk-through locally; created key works with curl against `localhost` on `GET /api/v1/mailboxes`.
4. Header link and `MCPPanel` block. → Check: visual.

### Phase 3: harden existing routes

Per resource, in this order: config and mailboxes, emails, drafts, threads, folders, search, attachments.

1. Convert to `OpenAPIHono` routes with zod request and response schemas. → Check: `GET /api/v1/openapi.json` validates with any OpenAPI 3.1 validator; UI still works.
2. Error envelope and consistent list envelope, `ApiError` updated. → Check: UI error toasts still show messages.
3. Route write paths through `workers/lib/tools.ts`, extending signatures for cc/bcc/attachments, `verify` flag per D3. → Check: MCP tool tests (added here) and REST tests produce the same DO state for the same inputs.

### Phase 4: parity endpoints

1. Add `draft-reply`, `PATCH drafts/:id`, `DELETE drafts/:id`. → Check: tests; spec updated.
2. Mailbox scoping enforcement if D4 accepted. → Check: scoped key gets 404 on a mailbox outside its list and a filtered `GET /mailboxes`.

### Phase 5: deploy and document

1. Access dashboard change per D1. → Check: `curl -H "Authorization: Bearer aik_..." https://mail.../api/v1/mailboxes` returns JSON from outside a browser session; the UI still loads and lists mail.
2. README section. → Check: a teammate can follow it to a working curl call.
3. Optional D5: accept keys on `/mcp`. → Check: Claude Code connects with a header-only config.

## Risks

- **Phase 5 step 1 is the only step that can lock people out.** If the bypass application is created before the cookie fallback ships, the UI stops working. Ship Phases 1 to 4, then change Access.
- **Response-shape changes in Phase 3 touch the UI.** Keep each resource's server and client change in one commit.
- **`@hono/zod-openapi` and Kumo's zod override.** Kumo pins zod through `overrides`. Confirm the OpenAPI package resolves to the same zod instance before committing to it; if it does not, use `hono-openapi`.
- **Mailbox ids are email addresses in URLs.** `requireMailbox` already decodes them. New routes must do the same.

## Out of scope

- Per-user permissions beyond the key scope in D4.
- Webhooks or push notifications for new mail.
- Changing how the AI agent authenticates.
- OAuth for MCP clients.
