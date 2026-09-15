/**
 * Where the language model comes from.
 *
 * The app talks to any **OpenAI- or Anthropic-compatible** endpoint; nothing
 * here is specific to a vendor. All of it is configuration (see
 * `.dev.vars.example` / the README):
 *
 *   AI_PROVIDER   "openai" (default) | "anthropic" — which request/response
 *                 protocol the endpoint speaks, not who hosts it.
 *   AI_BASE_URL   the endpoint. Defaults per protocol.
 *   AI_API_KEY    the credential for it.
 *   AI_MODEL      the model id to ask for.
 *
 * Because the protocol (not the vendor) is the knob, one config covers OpenAI,
 * Anthropic, OpenRouter, a local Ollama / vLLM / LM Studio server, Azure-style
 * gateways, and anything else that mimics one of the two APIs.
 *
 * Two back-compat aliases are kept so existing installs keep working:
 * `OPENROUTER_API_KEY` supplies the key (with OpenRouter's base URL and an
 * OpenRouter-style model id), and `NEWSLETTER_MODEL` supplies the model. Both
 * are checked *after* their `AI_*` counterparts, and both stay inside the
 * openai-compatible branch — config is interpreted the same way everywhere.
 *
 * The one place protocol genuinely leaks into the product is the default model
 * id: OpenAI and Anthropic name their models differently, so an unset
 * `AI_MODEL` resolves per protocol rather than to one shared string.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { APICallError, type LanguageModel } from "ai";

/** Which request/response protocol the endpoint speaks. */
export type AiProtocol = "openai" | "anthropic";

/** The env a model config is read from — the Worker bindings. */
export type AiEnv = {
  AI_PROVIDER?: string;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  NEWSLETTER_MODEL?: string;
};

/** A resolved, ready-to-use model — everything the rest of the server needs. */
export interface AiConfig {
  protocol: AiProtocol;
  /** The endpoint, normalised so the SDK appends the right path to it. */
  baseURL: string;
  apiKey: string;
  model: string;
  /**
   * Ceiling on output tokens. Generation writes a whole newsletter in one
   * call, so the provider's own default (4096 on some endpoints) truncates it.
   */
  maxOutputTokens: number;
  /** Credited in the OpenRouter "who is calling" headers, when applicable. */
  appTitle: string;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

const DEFAULT_MODELS: Record<AiProtocol, string> = {
  openai: "gpt-4.1",
  anthropic: "claude-sonnet-4-5",
};

/** OpenRouter ids are namespaced (`vendor/model`), so the legacy key assumes it. */
const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-4";

/** Env vars that name a model, in precedence order (also used in error copy). */
export const MODEL_ENV_VARS = ["AI_MODEL", "NEWSLETTER_MODEL"] as const;
/** Env vars that carry a credential, in precedence order (also used in error copy). */
export const API_KEY_ENV_VARS = ["AI_API_KEY", "OPENROUTER_API_KEY"] as const;

const MAX_OUTPUT_TOKENS = 8192;

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      `AI is not configured. Set ${API_KEY_ENV_VARS.join(" or ")} — plus AI_PROVIDER ` +
      `("openai" or "anthropic"), AI_BASE_URL and AI_MODEL for anything other than ` +
      `the default endpoint.`,
    );
    this.name = "AiNotConfiguredError";
  }
}

/**
 * Repair the shapes people actually paste for a base URL, so the SDK can build
 * a correct request from any of them:
 *
 *   api.openai.com            → https://api.openai.com/v1   (add scheme + path)
 *   .../v1/chat/completions   → .../v1                      (copy-paste from docs)
 *   http://host:11434/v1/     → http://host:11434/v1        (trailing slash)
 *
 * Both protocols append their own suffix (`/chat/completions`, `/messages`), so
 * a trailing `/v1` is preserved rather than stripped.
 */
export function normalizeBaseURL(raw: string): string {
  let url = raw.trim();
  if (!url) return url;
  // Copied from a curl example rather than the docs' base-URL field.
  url = url.replace(/\/+(chat\/completions|completions|messages)\/?$/i, "");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  // Bare hosts get the conventional version prefix (Ollama, LM Studio, …).
  try {
    if (!new URL(url).pathname.replace(/\/+$/, "")) url = `${url}/v1`;
  } catch {
    /* not a parseable URL — hand it to the SDK as typed */
  }
  return url;
}

/** `new URL` throws on garbage, so probe before treating a value as a URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function readProtocol(env: AiEnv): AiProtocol {
  const raw = (env.AI_PROVIDER || "").trim().toLowerCase();
  if (!raw) return "openai";
  if (raw === "openai" || raw === "openai-compatible" || raw === "openai_compatible") return "openai";
  if (raw === "anthropic" || raw === "anthropic-compatible" || raw === "anthropic_compatible") return "anthropic";
  throw new Error(`AI_PROVIDER must be "openai" or "anthropic" (got "${env.AI_PROVIDER}").`);
}

function fail(varName: string, raw: string, expected: string): never {
  throw new Error(`${varName} must ${expected} (got "${raw}").`);
}

/** The model id, falling back to a sensible default for the chosen protocol. */
export function resolveModel(env: AiEnv, protocol: AiProtocol): string {
  const explicit = (env.AI_MODEL || "").trim() || (env.NEWSLETTER_MODEL || "").trim();
  if (explicit) return explicit;
  return defaultsToOpenRouterModel(env, protocol) ? OPENROUTER_DEFAULT_MODEL : DEFAULT_MODELS[protocol];
}

/**
 * When nothing names a model but the endpoint is OpenRouter, the model id has
 * to follow OpenRouter's namespaced convention — the protocol defaults
 * ("gpt-4.1", "claude-sonnet-4-5") are bare names its API rejects.
 */
function defaultsToOpenRouterModel(env: AiEnv, protocol: AiProtocol): boolean {
  if (protocol !== "openai") return false;
  // Only the legacy key is set, so the endpoint is OpenRouter by construction.
  if (!(env.AI_API_KEY || "").trim() && (env.OPENROUTER_API_KEY || "").trim()) return true;
  return (env.AI_BASE_URL || "").toLowerCase().includes("openrouter");
}

/**
 * Resolve the env into a model config, or `null` when nothing is configured —
 * callers use that to say "connect a model" instead of failing mid-request.
 */
export function resolveAiConfig(env: AiEnv): AiConfig | null {
  const apiKey = API_KEY_ENV_VARS.map((k) => (env[k] || "").trim()).find(Boolean);
  if (!apiKey) return null;

  const protocol = readProtocol(env);
  const rawBase = (env.AI_BASE_URL || "").trim();
  const baseURL = rawBase
    ? normalizeBaseURL(rawBase)
    : // The legacy OpenRouter key implies its endpoint, unless AI_API_KEY (i.e.
    // a deliberate new-style config) is what supplied the credential.
    (env.OPENROUTER_API_KEY || "").trim() && !(env.AI_API_KEY || "").trim()
      ? OPENROUTER_BASE_URL
      : protocol === "anthropic"
        ? ANTHROPIC_BASE_URL
        : OPENAI_BASE_URL;
  if (rawBase && !isHttpUrl(baseURL)) fail("AI_BASE_URL", rawBase, "be an http(s) URL");

  return {
    protocol,
    baseURL,
    apiKey,
    model: resolveModel(env, protocol),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    appTitle: "OpenNewsletter",
  };
}

/**
 * True when the endpoint is OpenRouter. Only affects optional attribution
 * headers, and is deliberately a substring test: it must never change which
 * protocol is used — `AI_PROVIDER` decides that.
 */
function isOpenRouter(baseURL: string): boolean {
  return baseURL.toLowerCase().includes("openrouter.ai");
}

/**
 * Build the provider for a config. Kept separate from `aiModel` so streaming
 * paths that need provider-specific options have the instance itself.
 */
export function createAiProvider(config: AiConfig) {
  if (config.protocol === "anthropic") {
    return createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL });
  }
  return createOpenAICompatible({
    name: "openai-compatible",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    // OpenRouter asks bulk callers to identify themselves; harmless elsewhere,
    // so only sent when we know the endpoint (and only for openai-compatible,
    // since an Anthropic-protocol proxy may reject unknown headers).
    ...(isOpenRouter(config.baseURL)
      ? { headers: { "HTTP-Referer": "https://clawnify.com", "X-Title": config.appTitle } }
      : {}),
    // Request a final usage chunk so token accounting isn't lost at stream end.
    includeUsage: true,
  });
}

/**
 * Resolve the env straight to a model, or throw with actionable copy. This is
 * the single entry point `agent.ts` and `ai.ts` use.
 */
export function aiModel(env: AiEnv): { config: AiConfig; model: LanguageModel } {
  const config = resolveAiConfig(env);
  if (!config) throw new AiNotConfiguredError();
  const provider = createAiProvider(config);
  return { config, model: provider(config.model) };
}

/**
 * Turn a provider/SDK failure into something worth showing a user. Endpoint
 * misconfiguration is now the common failure, so name the endpoint and model
 * rather than echoing an opaque upstream body.
 *
 * Branches on the SDK's structured error first: real provider messages vary
 * wildly between implementations ("Incorrect API key provided", "invalid
 * x-api-key", an empty body, a bare HTML error page), so matching on the
 * message text alone reliably misclassifies the cases that matter most. Text
 * matching stays as the fallback for errors that arrive without a status code.
 */
export function describeAiError(e: unknown, config: AiConfig): string {
  if (e instanceof AiNotConfiguredError) return e.message;

  // The upstream API answered — the status and body say exactly what's wrong,
  // which is far more useful than anything we could infer from prose.
  if (APICallError.isInstance(e)) {
    const detail = upstreamDetail(e);
    const suffix = detail ? ` The endpoint said: ${detail}` : "";
    switch (e.statusCode) {
      case 401:
      case 403:
        return `${config.protocol} endpoint rejected the API key (${config.baseURL}). Check ${API_KEY_ENV_VARS.join(" / ")}.${suffix}`;
      case 404:
        return `The endpoint has no model "${config.model}" or no ${config.protocol} route at ${config.baseURL}. Set AI_MODEL to a model it serves.${suffix}`;
      case 429:
        return `The endpoint rate-limited or has no quota left.${suffix}`;
      default:
        if (e.statusCode && e.statusCode >= 500) {
          return `The endpoint at ${config.baseURL} failed (${e.statusCode}).${suffix}`;
        }
        return `${config.protocol} endpoint error (${e.statusCode ?? "no status"}): ${detail || e.message}`;
    }
  }

  const message = e instanceof Error ? e.message : String(e);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|connect|network|dns/i.test(message)) {
    return `Could not reach ${config.baseURL}. Check AI_BASE_URL and that the endpoint is running.`;
  }
  if (/max_tokens|max output tokens|too long/i.test(message)) {
    return `The response hit the ${config.maxOutputTokens}-token ceiling. Raise maxOutputTokens in server/llm.ts or shorten the request.`;
  }
  return `${config.protocol} endpoint error: ${message}`;
}

/**
 * The endpoint's own message, if it sent JSON. Providers disagree on the shape
 * (`{error:{message}}` for OpenAI, `{error:{type,message}}` for Anthropic), and
 * some return HTML — anything unparseable is passed through truncated rather
 * than swallowed, since it is often the only clue about a proxy's config.
 */
function upstreamDetail(e: APICallError): string {
  const body = e.responseBody?.trim();
  if (!body) return e.message;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const err = parsed.error;
    if (typeof err === "string") return err.slice(0, 300);
    if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
      return err.message.slice(0, 300);
    }
    if (typeof parsed.message === "string") return parsed.message.slice(0, 300);
    return body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}
