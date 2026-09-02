// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Vitest global setup: serves a fixed JWKS on localhost so tests can sign
 * Cloudflare Access JWTs and verify them without outbound network access.
 *
 * The origin and the signing key are provided to tests as injected context;
 * the vitest config forwards them as worker bindings.
 */
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair } from "jose";
import type { ProvidedContext } from "vitest";

export default async function setup({
	provide,
}: {
	provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
}): Promise<() => Promise<void>> {
	const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
	const publicJwk = await exportJWK(publicKey);
	publicJwk.kid = "test-key";
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";
	provide("privateJwk", JSON.stringify(await exportJWK(privateKey)));

	const server: Server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ keys: [publicJwk] }));
	});
	await new Promise<void>((resolve) => server.listen(4991, "127.0.0.1", resolve));
	provide("jwksOrigin", "http://127.0.0.1:4991");

	return async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		);
	};
}

declare module "vitest" {
	interface ProvidedContext {
		jwksOrigin: string;
		privateJwk: string;
	}
}
