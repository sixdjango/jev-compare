import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { TypeSafeClientConfig } from "@typesafe-ai/sdk";

type Fetch = NonNullable<TypeSafeClientConfig["fetch"]>;

/**
 * The proxy URL to use: `proxy` when it is a string, nothing when it is `false`, and otherwise
 * `HTTPS_PROXY`, then `HTTP_PROXY`, then `ALL_PROXY` (either case) from `env`.
 */
export function resolveProxy(proxy: string | false | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (proxy === false) return undefined;
  if (proxy) return proxy;
  return (
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || undefined
  );
}

/** A proxy URL that can't be used: invalid, or with a scheme other than HTTP or HTTPS. */
export class ProxyUrlError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ProxyUrlError";
  }
}

/**
 * `proxyUrl` as a full URL, with `http://` when no scheme is given, as curl does.
 * @throws {ProxyUrlError} The URL is invalid or its scheme isn't HTTP or HTTPS, such as `socks5://`.
 */
export function normalizeProxyUrl(proxyUrl: string): string {
  const full = withScheme(proxyUrl);
  let url: URL;
  try {
    url = new URL(full);
  } catch {
    throw new ProxyUrlError(`Invalid proxy URL: ${redactUrl(full)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProxyUrlError(
      `Unsupported proxy scheme "${url.protocol.slice(0, -1)}" in ${redactUrl(proxyUrl)}; only http:// and https:// proxies are supported`,
    );
  }
  return url.href;
}

/** `proxyUrl` with `http://` in front when it has no scheme, as curl reads it. */
export function withScheme(proxyUrl: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`;
}

/** `text` with the user name and password of every URL in it replaced by `***`. */
export function redactUrl(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/gi, "$1***@");
}

/** One agent per proxy URL, so connections are pooled across clients. */
const agents = new Map<string, EnvHttpProxyAgent>();

/**
 * A `fetch` that sends requests through the HTTP(S) proxy `proxyUrl`, honoring `NO_PROXY`.
 * It doesn't depend on Node's `--use-env-proxy` or `NODE_USE_ENV_PROXY`.
 * @throws {ProxyUrlError} The URL is invalid or its scheme isn't supported.
 */
export function proxyFetch(proxyUrl: string): Fetch {
  const uri = normalizeProxyUrl(proxyUrl);
  let agent = agents.get(uri);
  if (!agent) {
    agent = new EnvHttpProxyAgent({ httpProxy: uri, httpsProxy: uri });
    agents.set(uri, agent);
  }
  const dispatcher = agent;
  return (input, init) =>
    undiciFetch(input, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher }) as unknown as Promise<Response>;
}
