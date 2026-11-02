// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Forward rule management: /api/v1/forwarding.
 *
 * A rule sends a copy of mail off this deployment, so only signed-in people may
 * manage rules. API keys and the MCP server cannot, which stops a leaked key or
 * a prompt-injected agent from redirecting mail.
 */
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { requireAccessPrincipal } from "../lib/auth";
import { apiError, validationErrorHook } from "../lib/errors";
import type { MailboxContext } from "../lib/mailbox";
import { ApiErrorSchema } from "../lib/schemas";
import type { Env } from "../types";
import { type DestinationApiConfig, getDestinationStatuses, registerDestination } from "./destinations";
import { deleteForwardRule, getForwardRule, listForwardRules, putForwardRule } from "./store";

const ForwardRuleSchema = z.object({
	source: z.string(),
	destination: z.string(),
	created_at: z.string(),
	created_by: z.string().nullable(),
	destination_status: z.enum(["verified", "pending", "unknown"]),
});

const DestinationSchema = z.object({
	email: z.string(),
	status: z.enum(["verified", "pending"]),
});

const CreateForwardRuleBody = z.object({
	source: z.string().email(),
	destination: z.string().email(),
});

const SOURCE_PARAM = z.object({ source: z.string() });

const FORBIDDEN_403 = {
	description: "API keys cannot manage forward rules",
	content: { "application/json": { schema: resolver(ApiErrorSchema) } },
};

function destinationApi(env: Env): DestinationApiConfig {
	return { token: env.EMAIL_ROUTING_API_TOKEN, accountId: env.EMAIL_ROUTING_ACCOUNT_ID };
}

function isLocalAddress(env: Env, address: string): boolean {
	const domains = (env.DOMAINS || "").split(",").map((d) => d.trim().toLowerCase());
	return domains.includes(address.slice(address.lastIndexOf("@") + 1));
}

export const forwardingRoutes = new Hono<MailboxContext>();

forwardingRoutes.use("/api/v1/forwarding/*", requireAccessPrincipal);

forwardingRoutes.get(
	"/api/v1/forwarding",
	describeRoute({
		description:
			"List forward rules with the verification status of each destination, and every destination on the Cloudflare account. Destinations are empty when Cloudflare can't be asked.",
		responses: {
			200: {
				description: "Rules and destinations",
				content: {
					"application/json": {
						schema: resolver(z.object({ rules: z.array(ForwardRuleSchema), destinations: z.array(DestinationSchema) })),
					},
				},
			},
			403: FORBIDDEN_403,
		},
	}),
	async (c) => {
		const [rules, statuses] = await Promise.all([
			listForwardRules(c.env.BUCKET),
			getDestinationStatuses(destinationApi(c.env)),
		]);
		return c.json({
			rules: rules.map((rule) => ({ ...rule, destination_status: statuses?.get(rule.destination) ?? "unknown" })),
			destinations: [...(statuses ?? [])].map(([email, status]) => ({ email, status })),
		});
	},
);

forwardingRoutes.post(
	"/api/v1/forwarding",
	describeRoute({
		description:
			"Forward mail for an address on this deployment's domains to an outside address. If the address also has a mailbox, mail is stored and forwarded. New destinations are registered with Cloudflare, which must verify them before mail is delivered.",
		responses: {
			201: {
				description: "Created rule",
				content: { "application/json": { schema: resolver(z.object({ rule: ForwardRuleSchema })) } },
			},
			400: { description: "Invalid addresses", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
			403: FORBIDDEN_403,
			409: { description: "Rule already exists", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
		},
	}),
	validator("json", CreateForwardRuleBody, validationErrorHook),
	async (c) => {
		const body = c.req.valid("json");
		const source = body.source.toLowerCase();
		const destination = body.destination.toLowerCase();

		if (!isLocalAddress(c.env, source)) {
			return apiError(c, 400, "bad_request", "The forwarded address must be on one of this deployment's domains");
		}
		// A destination handled by this Worker could bounce mail between two rules forever.
		if (isLocalAddress(c.env, destination)) {
			return apiError(c, 400, "bad_request", "The destination must be outside this deployment's domains");
		}
		if (await getForwardRule(c.env.BUCKET, source)) {
			return apiError(c, 409, "conflict", `A forward rule for ${source} already exists`);
		}

		const principal = c.get("principal");
		const rule = {
			source,
			destination,
			created_at: new Date().toISOString(),
			created_by: principal.kind === "access" ? principal.email : null,
		};
		await putForwardRule(c.env.BUCKET, rule);
		const destination_status = await registerDestination(destinationApi(c.env), destination);
		return c.json({ rule: { ...rule, destination_status } }, 201);
	},
);

forwardingRoutes.delete(
	"/api/v1/forwarding/:source",
	describeRoute({
		description: "Delete a forward rule. The destination stays registered on the Cloudflare account.",
		responses: {
			204: { description: "Deleted" },
			403: FORBIDDEN_403,
			404: { description: "Not found", content: { "application/json": { schema: resolver(ApiErrorSchema) } } },
		},
	}),
	validator("param", SOURCE_PARAM, validationErrorHook),
	async (c) => {
		const source = c.req.valid("param").source.toLowerCase();
		if (!(await getForwardRule(c.env.BUCKET, source))) {
			return apiError(c, 404, "not_found", "Forward rule not found");
		}
		await deleteForwardRule(c.env.BUCKET, source);
		return c.body(null, 204);
	},
);
