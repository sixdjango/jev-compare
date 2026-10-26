import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError, RateLimitError, TypeSafeError } from "@typesafe-ai/sdk";
import { ImageFormatError } from "./image.ts";
import { ProxyUrlError, redactUrl, resolveProxy, withScheme } from "./proxy.ts";
import type { Locale } from "./prompts.ts";

/** What went wrong, coarsely enough to act on. */
export type ErrorKind =
  | "auth" // No API key, or the API rejected it (401)
  | "permission" // The API key isn't allowed to do this (403)
  | "region" // The API isn't available from where the request came from (451)
  | "rate_limit" // Too many requests (429)
  | "bad_request" // The API rejected the request (400, 404, 413, 422)
  | "server" // The API failed (5xx)
  | "api" // Another non-2xx response
  | "timeout" // No full response within the timeout
  | "proxy" // The proxy URL is unusable, the proxy can't be reached, or it refused the request
  | "network" // The API can't be reached (DNS, TLS, connection reset, ...)
  | "aborted" // Cancelled through `signal`
  | "invalid_input" // A bad image, option or file path
  | "unknown";

/** One error in the `cause` chain, redacted. */
export interface ErrorCause {
  name: string;
  message: string;
  code?: string;
}

/** An error reduced to fields safe to log or show: API keys and proxy credentials are replaced by `***`. */
export interface ErrorSummary {
  kind: ErrorKind;
  /** The error's class name, such as `AuthenticationError` or `APIConnectionError`. */
  name: string;
  message: string;
  /** HTTP status, for API responses. */
  status?: number;
  /** The API's request ID, to quote when reporting a problem. */
  requestId?: string;
  /** How long the API asked to wait before retrying, for `rate_limit`. */
  retryAfterMs?: number;
  /** The most specific error code in the chain, such as `ECONNREFUSED` or `UND_ERR_SOCKET`. */
  code?: string;
  /** The proxy the request went through, if any, without credentials. */
  proxy?: string;
  /** What to try next. */
  hint?: string;
  /** The errors under this one, outermost first. */
  causes: ErrorCause[];
}

export interface SummarizeErrorOptions {
  /** The `proxy` option the request was made with; the environment decides when omitted, as for `compareImages`. */
  proxy?: string | false;
  /** More strings to redact, besides the API key and proxy credentials. */
  secrets?: string[];
  /** Language of `hint`. Default: "en". */
  locale?: Locale;
  /** Where `JEV_KEY`, `TYPESAFE_API_KEY` and proxy variables are read from. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const MAX_MESSAGE = 500;
const MAX_CAUSES = 8;

/**
 * Summarize an error from `compareImages` or the CLI as plain, redacted data: what kind of
 * failure it is, the HTTP status, request ID, error code and proxy, and a hint on what to try.
 * The result is safe to log, print or send to an error tracker.
 */
export function summarizeError(error: unknown, options: SummarizeErrorOptions = {}): ErrorSummary {
  const env = options.env ?? process.env;
  const locale = options.locale ?? "en";
  const resolved = resolveProxy(options.proxy, env);
  const proxyUrl = resolved && withScheme(resolved);
  const redact = redactor([env.JEV_KEY, env.TYPESAFE_API_KEY, ...proxySecrets(proxyUrl), ...(options.secrets ?? [])]);

  const chain = causeChain(error);
  const top = chain[0];
  const causes = chain.slice(1).map((c) => ({ name: errorName(c), message: redact(messageOf(c)), ...codeField(c) }));
  const code = [...chain].reverse().map(codeOf).find((c) => c !== undefined);
  const kind = classify(error, chain, proxyUrl);

  return {
    kind,
    name: top ? errorName(top) : typeof error,
    message: redact(top ? messageOf(top) : String(error)),
    ...(error instanceof APIError ? { status: error.status } : {}),
    ...(error instanceof APIError && error.requestId ? { requestId: error.requestId } : {}),
    ...(error instanceof RateLimitError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(code ? { code } : {}),
    ...(proxyUrl ? { proxy: redact(redactUrl(proxyUrl)) } : {}),
    ...hintField(hint(kind, locale, { error, chain, proxyUrl })),
    causes,
  };
}

function classify(error: unknown, chain: Error[], proxyUrl: string | undefined): ErrorKind {
  if (error instanceof APIUserAbortError || (error instanceof Error && error.name === "AbortError")) return "aborted";
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof APIError) {
    const s = error.status;
    if (s === 401) return "auth";
    if (s === 403) return "permission";
    if (s === 451) return "region";
    if (s === 429) return "rate_limit";
    if (s === 400 || s === 404 || s === 413 || s === 422) return "bad_request";
    if (s >= 500) return "server";
    return "api";
  }
  if (error instanceof ProxyUrlError) return "proxy";
  if (error instanceof APIConnectionError) return proxyFailure(chain, proxyUrl) ? "proxy" : "network";
  if (error instanceof TypeSafeError && /API key/i.test(error.message)) return "auth";
  if (error instanceof ImageFormatError || error instanceof TypeError || error instanceof RangeError) return "invalid_input";
  if (["ENOENT", "EISDIR", "EACCES", "ENOTDIR"].includes(codeOf(error) ?? "")) return "invalid_input";
  return "unknown";
}

type ProxyFailure = "unreachable" | "auth" | "refused";

/** How the proxy failed, when the chain shows it was the proxy and not the API. */
function proxyFailure(chain: Error[], proxyUrl: string | undefined): ProxyFailure | undefined {
  if (!proxyUrl) return undefined;
  let proxy: URL | undefined;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    // An unusable URL fails earlier, with a ProxyUrlError.
  }
  for (const c of chain) {
    const status = /Proxy response \((\d+)\)/.exec(c.message)?.[1];
    if (status) return status === "407" ? "auth" : "refused";
    // A failed connect names the address it dialed; when that's the proxy, the API was never reached.
    const dialed = c as { port?: unknown; hostname?: unknown };
    if (proxy && (String(dialed.port) === defaultPort(proxy) || dialed.hostname === proxy.hostname)) return "unreachable";
  }
  return undefined;
}

function defaultPort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function hint(
  kind: ErrorKind,
  locale: Locale,
  { error, chain, proxyUrl }: { error: unknown; chain: Error[]; proxyUrl: string | undefined },
): string | undefined {
  const t = (en: string, zh: string) => (locale === "zh" ? zh : en);
  switch (kind) {
    case "auth":
      return t("Check the API key in JEV_KEY or TYPESAFE_API_KEY.", "检查 JEV_KEY 或 TYPESAFE_API_KEY 中的 API key。");
    case "permission":
      return t("This API key isn't allowed to make this request; check its access.", "该 API key 无权发起此请求，请检查其权限。");
    case "region":
      return proxyUrl
        ? t("The API isn't available from the proxy's region either; try another proxy exit.", "代理出口所在地区同样无法使用该 API，请换一个代理出口。")
        : t("The API isn't available in this region; set HTTPS_PROXY or ALL_PROXY, or pass --proxy.", "当前地区无法使用该 API，请设置 HTTPS_PROXY 或 ALL_PROXY，或使用 --proxy。");
    case "rate_limit": {
      const ms = error instanceof RateLimitError ? error.retryAfterMs : undefined;
      return ms === undefined
        ? t("Rate limited; retry later.", "请求过于频繁，请稍后重试。")
        : t(`Rate limited; retry in ${Math.ceil(ms / 1000)} s.`, `请求过于频繁，请在 ${Math.ceil(ms / 1000)} 秒后重试。`);
    }
    case "bad_request":
      return t("The API rejected the request; see the message for the reason.", "API 拒绝了该请求，原因见错误信息。");
    case "server":
      return t("The API failed; retry later, and quote the request ID if it keeps failing.", "API 内部出错，请稍后重试；持续失败时请附上 request ID 反馈。");
    case "timeout":
      return t(
        "No response in time; check the network or proxy, or raise clientOptions.timeout.",
        "请求超时，请检查网络或代理，或调大 clientOptions.timeout。",
      );
    case "proxy": {
      if (error instanceof ProxyUrlError) {
        return t(
          "Use an HTTP(S) proxy URL, such as http://127.0.0.1:7890; the mixed port of clients like Clash speaks both.",
          "请改用 HTTP(S) 代理地址，例如 http://127.0.0.1:7890；Clash 等客户端的混合端口（mixed-port）同时支持 HTTP。",
        );
      }
      const failure = proxyFailure(chain, proxyUrl);
      if (failure === "unreachable") {
        return t("Can't reach the proxy; check that it's running and the address is right.", "无法连接代理，请确认代理已启动且地址正确。");
      }
      if (failure === "auth") return t("The proxy rejected the credentials; check the user name and password.", "代理拒绝了认证，请检查用户名和密码。");
      return t("The proxy couldn't connect to the API; check the proxy's rules and exit.", "代理无法连接到 API，请检查代理规则和出口。");
    }
    case "network":
      return proxyUrl
        ? t("Can't reach the API; check the network.", "无法连接 API，请检查网络。")
        : t("Can't reach the API; check the network, or set HTTPS_PROXY or ALL_PROXY.", "无法连接 API，请检查网络，或设置 HTTPS_PROXY 或 ALL_PROXY。");
    default:
      return undefined;
  }
}

/** The error and its causes, outermost first, following `cause` and the first of an `AggregateError`'s errors. */
function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  let e: unknown = error;
  while (e instanceof Error && chain.length < MAX_CAUSES && !chain.includes(e)) {
    chain.push(e);
    e = e.cause ?? (e instanceof AggregateError ? e.errors[0] : undefined);
  }
  return chain;
}

function errorName(e: Error): string {
  return e.name && e.name !== "Error" ? e.name : e.constructor?.name || "Error";
}

function messageOf(e: Error): string {
  const m = e.message || (e instanceof AggregateError ? e.errors.map((x) => String((x as Error)?.message ?? x)).join("; ") : "");
  return m.length > MAX_MESSAGE ? `${m.slice(0, MAX_MESSAGE)}…` : m;
}

function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : undefined;
}

function codeField(e: Error): { code?: string } {
  const code = codeOf(e);
  return code ? { code } : {};
}

function hintField(hint: string | undefined): { hint?: string } {
  return hint ? { hint } : {};
}

/** The user name and password in a proxy URL. */
function proxySecrets(proxyUrl: string | undefined): string[] {
  const userinfo = proxyUrl && /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]*)@/i.exec(proxyUrl)?.[1];
  if (!userinfo) return [];
  return userinfo.split(":").flatMap((part) => [part, safeDecode(part)]);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A function that replaces `secrets`, URL credentials, auth headers and token query parameters with `***`. */
function redactor(secrets: Array<string | undefined>): (text: string) => string {
  // Short strings would match ordinary words; API keys and passwords worth hiding are longer.
  const literal = [...new Set(secrets.filter((s): s is string => !!s && s.length >= 4))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = redactUrl(text)
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***")
      .replace(/([?&](?:api[_-]?key|key|token|access_token|password|secret|signature|sig)=)[^&\s#]+/gi, "$1***");
    for (const s of literal) out = out.split(s).join("***");
    return out;
  };
}
