import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { TypeSafeClientConfig } from "@typesafe-ai/sdk";

type Fetch = NonNullable<TypeSafeClientConfig["fetch"]>;

/**
 * The proxy URL to use: `proxy` when it is a string, nothing when it is `false`, and otherwise
 * `HTTPS_PROXY`, then `HTTP_PROXY` (either case) from `env`.
 */
export function resolveProxy(proxy: string | false | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (proxy === false) return undefined;
  if (proxy) return proxy;
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || undefined;
}

/** One agent per proxy URL, so connections are pooled across clients. */
const agents = new Map<string, EnvHttpProxyAgent>();

/**
 * A `fetch` that sends requests through `proxyUrl`, honoring `NO_PROXY`. It doesn't depend on
 * Node's `--use-env-proxy` or `NODE_USE_ENV_PROXY`.
 */
export function proxyFetch(proxyUrl: string): Fetch {
  let agent = agents.get(proxyUrl);
  if (!agent) {
    agent = new EnvHttpProxyAgent({ httpProxy: proxyUrl, httpsProxy: proxyUrl });
    agents.set(proxyUrl, agent);
  }
  const dispatcher = agent;
  return (input, init) =>
    undiciFetch(input, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher }) as unknown as Promise<Response>;
}
