<div align="center">
  <h1>Agentic Inbox</h1>
  <p><em>A self-hosted email client with an AI agent, running entirely on Cloudflare Workers</em></p>
</div>

Agentic Inbox lets you send, receive, and manage emails through a modern web interface -- all powered by your own Cloudflare account. Incoming emails arrive via [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in its own [Durable Object](https://developers.cloudflare.com/durable-objects/) with a SQLite database, and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

An **AI-powered Email Agent** can read your inbox, search conversations, and draft replies -- built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) and [Workers AI](https://developers.cloudflare.com/workers-ai/).

![Agentic Inbox screenshot](./demo_app.png)


Read the blog post to learn more about Cloudflare Email Service and how to use it with the Agents SDK, MCP, and from the Wrangler CLI: [Email for Agents](https://blog.cloudflare.com/email-for-agents/).

## How to setup

**Important**: Clicking the 'Deploy to Cloudflare' button is only one part of the setup. You must follow the **After deploying** steps as well. For a full step-by-step guide with screenshots, refer to this comment: 
https://github.com/cloudflare/agentic-inbox/issues/4#issuecomment-4269118513

### To set up

1. Deploy to Cloudflare. The deploy flow will automatically provision R2, Durable Objects, and Workers AI. You'll be prompted for **DOMAINS**, which is the domain (yourdomain.com) you want to receive emails for (email@yourdomain.com).

     [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agentic-inbox)

2. **Configure Clerk** -- Create a Clerk application with a production instance on a domain that contains this Worker's hostname, because a Clerk session only reaches subdomains of that domain. Add the session token claim `{"email": "{{user.primary_email_address}}"}` under Sessions. Set `CLERK_PUBLISHABLE_KEY`, `CLERK_SIGN_IN_URL` (the Account Portal sign-in page) and `CANONICAL_HOST` in `wrangler.jsonc`, then set the `CLERK_SECRET_KEY` and `ALLOWED_EMAILS` Worker secrets. `ALLOWED_EMAILS` is comma-separated: full addresses, or `@domain` for a whole domain.
3. **Set up Email Routing** -- In the Cloudflare dashboard, go to your domain > Email Routing and create a catch-all rule that forwards to this Worker
4. **Enable Email Service** -- The worker needs the `send_email` binding to send outbound emails. See [Email Service docs](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
5. **Create a mailbox** -- Visit your deployed app and create a mailbox for any address on your domain (e.g. `hello@example.com`)

### Troubleshooting sign-in

1. If you see `Clerk must be configured in production`, a Clerk setting is missing. The Worker refuses to run without one so your inbox is not exposed to anyone on the internet.
2. If you see `This account is not allowed to use this inbox`, the signed-in email is not on `ALLOWED_EMAILS`, or the session token has no `email` claim.

## API access

Scripts and agents can call the REST API with an API key instead of a browser session. The key authenticates the REST surface at `/api/v1/*` and the MCP server at `/mcp`. The AI agent WebSocket (`/agents/*`) stays browser-only.

### Creating and using a key

1. Open your deployed app and go to **API keys** (the key icon in the header, or `/settings/api-keys`).
2. Click **Create key**, give it a name, and optionally set an expiry or restrict it to specific mailboxes.
3. Copy the key. It is shown once and stored only as a SHA-256 hash.

Every key can do what a signed-in user can do, restricted to the mailboxes you selected. Use `curl`:

```bash
curl -H "Authorization: Bearer aik_..." https://mail.example.com/api/v1/mailboxes
```

The machine-readable contract lives at `GET /api/v1/openapi.json` (OpenAPI 3.1). Errors use the envelope `{"error": {"code": "not_found", "message": "..."}}`.

### MCP with an API key

Point an MCP client at `https://mail.example.com/mcp` with the header `Authorization: Bearer aik_...`.

### The inbox CLI

`inbox`, a compiled CLI for the same API, ships from this repo. Install it from a release (or build it yourself with `bun` and `cli/scripts/build-all.sh`):

```bash
curl -fsSL <release-asset-base>/install.sh | bash
```

Log in once, then explore:

```
inbox auth login --url https://mail.example.com --api-key aik_...
inbox mailboxes list
inbox emails list --mailbox hello@example.com
```

Credentials live in `$XDG_CONFIG_HOME/inbox/config.json` (mode 0600), falling back to `~/.config/inbox/config.json`.

If you run more than one deployment, give each a named profile instead of one shared default:

```
inbox --profile work auth login --url https://mail.work.example --api-key aik_...
inbox --profile home auth login --url https://mail.home.example --api-key aik_...

inbox auth profiles                 # names, urls, and which one is active
inbox --profile work emails list    # pick one per command
export INBOX_PROFILE=work           # or set it for the shell
```

`--profile` beats `INBOX_PROFILE`, which beats the config file. Naming a profile that does not exist is a usage error listing the ones that do. `inbox auth status` prints the active profile and url alongside the principal your key resolves to.

The CLI prints JSON when stdout is piped (or with `--json`) and tables on a terminal, and it never prompts when it is not attached to a terminal: destructive commands want `--yes` and exit 4 without it. Exit codes: 0 ok, 1 unexpected, 2 usage, 3 API 4xx, 4 confirmation required, 5 auth, 6 not found.

For agents, `inbox agent-docs` prints a compact, deterministic command reference sized for a system prompt.

Note for contributors: `cli/openapi.json` is a snapshot of the API contract, and `cli/src/generated/api.d.ts` is generated from it. If you change a route, run `npm run openapi:export` and then `bun run gen` inside `cli/`; a route rename fails the CLI build until you do.

### The verifyDraft difference

The MCP server and the agent run an AI pass (`verifyDraft`) over outgoing bodies to strip prompt-injection artifacts. The REST API does not do this by default: a human on the CLI would not expect a model to rewrite their text, and the guardrail belongs to whoever generated the content. To opt in, pass `"verify": true` on draft and send bodies.

## Features

- **Full email client** — Send and receive emails via Cloudflare Email Routing with a rich text composer, reply/forward threading, folder organization, search, and attachments
- **Per-mailbox isolation** — Each mailbox runs in its own Durable Object with SQLite storage and R2 for attachments
- **Built-in AI agent** — Side panel with 9 email tools for reading, searching, drafting, and sending
- **Auto-draft on new email** — Agent automatically reads inbound emails and generates draft replies, always requiring explicit confirmation before sending
- **Configurable and persistent** — Custom system prompts per mailbox, persistent chat history, streaming markdown responses, and tool call visibility

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing
- **AI Agent:** Cloudflare Agents SDK (`AIChatAgent`), AI SDK v6, Workers AI (`@cf/moonshotai/kimi-k2.5`), `react-markdown` + `remark-gfm`
- **Auth:** Clerk session with an email allowlist (required outside local development), or an API key

## Getting Started

```bash
npm install
npm run dev
```

### Configuration

1. Set your domain in `wrangler.jsonc`
2. Create an R2 bucket named `agentic-inbox`: `wrangler r2 bucket create agentic-inbox`

### Deploy

```bash
npm run deploy
```

## Prerequisites

- Cloudflare account with a domain
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for receiving
- [Email Service](https://developers.cloudflare.com/email-service/) enabled for sending
- [Workers AI](https://developers.cloudflare.com/workers-ai/) enabled (for the agent)
- [Clerk](https://clerk.com/docs) configured for deployed/shared environments (required in production)

Anyone on `ALLOWED_EMAILS` can access all mailboxes in this app by design. This includes the MCP server at `/mcp` -- external AI tools (Claude Code, Cursor, etc.) connected via MCP can operate on any mailbox by passing a `mailboxId` parameter. There is no per-mailbox authorization; the Cloudflare Access policy is the single trust boundary.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │────>│  Hono Worker     │────>│  MailboxDO      │
│  React SPA   │     │  (API + SSR)     │     │  (SQLite + R2)  │
│  Agent Panel │     │                  │     └─────────────────┘
└──────┬───────┘     │  /agents/* ──────┼────>┌─────────────────┐
       │             │                  │     │  EmailAgent DO  │
       │ WebSocket   │                  │     │  (AIChatAgent)  │
       └─────────────┤                  │     │  9 email tools  │
                     │                  │────>│  Workers AI     │
                     └──────────────────┘     └─────────────────┘
```

## License

Apache 2.0 -- see [LICENSE](LICENSE).
