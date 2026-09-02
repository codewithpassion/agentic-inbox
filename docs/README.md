# Docs

Planning documents for adding a key-authenticated REST API and a compiled CLI to Agentic Inbox. Written 2026-09-02. No implementation has started.

Read in order:

1. [`00-current-state.md`](./00-current-state.md). What exists today, why the app has no usable API despite having `/api/v1` routes, and a tool-by-tool comparison of the MCP server against the REST routes.
2. [`01-rest-api-plan.md`](./01-rest-api-plan.md). API keys stored in a Durable Object, dual authentication (Cloudflare Access or key), key management UI, hardening the existing routes with zod and OpenAPI, and closing the MCP parity gaps. Opens with six decisions that need answers before work starts. The first one, how to get key-authenticated requests past Cloudflare Access at the edge, is the one that can lock people out if done in the wrong order.
3. [`02-cli-plan.md`](./02-cli-plan.md). `inbox`, a Bun-compiled binary generated from the API's OpenAPI spec, designed for agents (JSON when piped, stable exit codes, `--yes`, `agent-docs`) and humans (tables, prompts, completions) at the same time. Depends on the API plan's Phases 2 through 4.
