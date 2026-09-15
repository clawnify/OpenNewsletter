/**
 * Endpoint resolution.
 *
 * The claim this file exists to protect: the app no longer depends on
 * OpenRouter. Two things can break that claim silently — `resolveAiConfig`
 * quietly preferring an OpenRouter env var, or the SDK building the wrong URL
 * for a base a user actually pastes — so both get asserted here, the URL one
 * against a real fetch rather than against our own string handling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { APICallError, generateText } from "ai";
import {
  aiModel,
  describeAiError,
  isHttpUrl,
  normalizeBaseURL,
  resolveAiConfig,
  resolveModel,
  AiNotConfiguredError,
  OPENROUTER_BASE_URL,
  type AiConfig,
} from "./llm";

const ANTHROPIC_DEFAULT = "https://api.anthropic.com/v1";
const OPENAI_DEFAULT = "https://api.openai.com/v1";

const configOf = (env: Parameters<typeof resolveAiConfig>[0]): AiConfig => {
  const config = resolveAiConfig(env);
  if (!config) throw new Error("expected a config");
  return config;
};

describe("resolveAiConfig", () => {
  it("is unconfigured without a key, whichever endpoint vars are set", () => {
    expect(resolveAiConfig({})).toBeNull();
    expect(resolveAiConfig({ AI_BASE_URL: "https://api.openai.com/v1", AI_MODEL: "gpt-4.1" })).toBeNull();
    // Whitespace is not a key: a blank value must not read as configured, or
    // every request 401s with an empty bearer token.
    expect(resolveAiConfig({ AI_API_KEY: "   " })).toBeNull();
  });

  it("defaults to OpenAI's endpoint and protocol", () => {
    const config = configOf({ AI_API_KEY: "sk-test" });
    expect(config.protocol).toBe("openai");
    expect(config.baseURL).toBe(OPENAI_DEFAULT);
    expect(config.model).toBe("gpt-4.1");
  });

  it("uses Anthropic's endpoint and a Claude default when told it's anthropic", () => {
    const config = configOf({ AI_API_KEY: "sk-ant-test", AI_PROVIDER: "anthropic" });
    expect(config.protocol).toBe("anthropic");
    expect(config.baseURL).toBe(ANTHROPIC_DEFAULT);
    expect(config.model).toBe("claude-sonnet-4-5");
  });

  it("accepts the protocol as written in prose, case-insensitively", () => {
    expect(configOf({ AI_API_KEY: "k", AI_PROVIDER: " Anthropic " }).protocol).toBe("anthropic");
    expect(configOf({ AI_API_KEY: "k", AI_PROVIDER: "openai-compatible" }).protocol).toBe("openai");
    expect(configOf({ AI_API_KEY: "k", AI_PROVIDER: "ANTHROPIC_COMPATIBLE" }).protocol).toBe("anthropic");
  });

  it("refuses an unknown protocol by name rather than silently choosing one", () => {
    expect(() => resolveAiConfig({ AI_API_KEY: "k", AI_PROVIDER: "gemini" })).toThrow(/AI_PROVIDER must/);
  });

  it("takes a fully custom endpoint, key and model", () => {
    const config = configOf({
      AI_PROVIDER: "anthropic",
      AI_BASE_URL: "https://llm.internal.example/anthropic/v1",
      AI_API_KEY: "key-1",
      AI_MODEL: "claude-opus-4-1",
    });
    expect(config).toMatchObject({
      protocol: "anthropic",
      baseURL: "https://llm.internal.example/anthropic/v1",
      apiKey: "key-1",
      model: "claude-opus-4-1",
    });
  });

  it("flags a base URL that isn't a URL, instead of failing on first request", () => {
    expect(() => resolveAiConfig({ AI_API_KEY: "k", AI_BASE_URL: "not a url" })).toThrow(/AI_BASE_URL must/);
  });

  // ── back-compat ──────────────────────────────────────────────────────

  it("still runs an existing OpenRouter-only install unchanged", () => {
    const config = configOf({ OPENROUTER_API_KEY: "sk-or-x" });
    expect(config.baseURL).toBe(OPENROUTER_BASE_URL);
    expect(config.apiKey).toBe("sk-or-x");
    // OpenRouter serves namespaced ids, so the bare "gpt-4.1" default would 404.
    expect(config.model).toBe("anthropic/claude-sonnet-4");
  });

  it("lets the new variables win over the legacy ones", () => {
    const config = configOf({
      AI_PROVIDER: "anthropic",
      AI_BASE_URL: "https://api.anthropic.com/v1",
      AI_API_KEY: "new-key",
      AI_MODEL: "claude-opus-4-1",
      OPENROUTER_API_KEY: "old-key",
      NEWSLETTER_MODEL: "anthropic/claude-sonnet-4",
    });
    expect(config.apiKey).toBe("new-key");
    expect(config.model).toBe("claude-opus-4-1");
  });

  it("honours NEWSLETTER_MODEL on an otherwise legacy install", () => {
    expect(configOf({ OPENROUTER_API_KEY: "sk-or-x", NEWSLETTER_MODEL: "openai/gpt-5" }).model).toBe(
      "openai/gpt-5",
    );
  });

  it("keeps OpenRouter's base URL when only the legacy key is set, even if the protocol is openai", () => {
    // AI_PROVIDER names a protocol, not a vendor: setting it must not drag the
    // endpoint (or the model id convention) away from OpenRouter.
    const config = configOf({ AI_PROVIDER: "openai", OPENROUTER_API_KEY: "sk-or-x" });
    expect(config.baseURL).toBe(OPENROUTER_BASE_URL);
    expect(config.model).toBe("anthropic/claude-sonnet-4");
  });

  it("uses OpenRouter's model convention when the custom base is OpenRouter", () => {
    expect(resolveModel({ AI_BASE_URL: "https://openrouter.ai/api/v1" }, "openai")).toBe(
      "anthropic/claude-sonnet-4",
    );
  });

  it("does not mistake a subdomain-suffixed host for something else", () => {
    // Substring test on purpose — this is the only thing that branches on host.
    expect(resolveModel({ AI_BASE_URL: "https://openrouter.ai.evil.example/v1" }, "openai")).toBe(
      "anthropic/claude-sonnet-4",
    );
  });
});

describe("normalizeBaseURL", () => {
  it("adds the scheme and /v1 to a bare host", () => {
    expect(normalizeBaseURL("api.openai.com")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseURL("localhost:11434")).toBe("https://localhost:11434/v1");
  });

  it("preserves an explicit scheme, port and path", () => {
    expect(normalizeBaseURL("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseURL("https://llm.internal.example/anthropic/v1")).toBe(
      "https://llm.internal.example/anthropic/v1",
    );
  });

  it("strips a trailing slash so the SDK's path join doesn't double up", () => {
    expect(normalizeBaseURL("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
  });

  it("turns a full request URL back into the base", () => {
    // Exactly what you get by copying the URL out of a curl example.
    expect(normalizeBaseURL("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseURL("https://api.anthropic.com/v1/messages")).toBe("https://api.anthropic.com/v1");
    // …even when the /v1 was also part of the copy-paste.
    expect(normalizeBaseURL("https://api.openai.com/v1/chat/completions/")).toBe("https://api.openai.com/v1");
  });

  it("leaves a version-less self-hosted path alone", () => {
    // A gateway mounting the API under its own prefix must not gain a /v1.
    expect(normalizeBaseURL("http://gateway.example/llm")).toBe("http://gateway.example/llm");
  });
});

describe("isHttpUrl", () => {
  it("accepts http(s) and rejects everything else", () => {
    expect(isHttpUrl("https://api.openai.com/v1")).toBe(true);
    expect(isHttpUrl("http://localhost:11434/v1")).toBe(true);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

// ── What actually goes on the wire ─────────────────────────────────────
//
// The point of the SDK is that this works for endpoints nobody here can reach.
// Asserting the built request is the only way to check that without one.
describe("aiModel requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** Capture the outgoing request and answer 401, so nothing is generated. */
  function captureRequest(): {
    url: () => string;
    headers: () => Headers;
    body: () => Record<string, unknown>;
  } {
    let seen: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    const request = () => {
      if (!seen) throw new Error("the model never made a request");
      return seen;
    };
    return {
      url: () => request().url,
      headers: () => new Headers(request().init.headers ?? {}),
      body: () =>
        typeof request().init.body === "string" ? JSON.parse(request().init.body as string) : {},
    };
  }

  /**
   * Resolve an env and drive one completion through it, the way the app does.
   *
   * `generateText` takes an options object — a bare model would make it re-read
   * the ambient env (including `ANTHROPIC_BASE_URL`), which both fails the call
   * and would refuse the endpoint the operator configured. `maxOutputTokens`
   * mirrors `generate()` in ai.ts / agent.ts and matters on Anthropic: it
   * requires max_tokens, and the SDK's fallback for an unrecognised id is 4096,
   * which truncates a whole newsletter.
   */
  async function generateFrom(env: Parameters<typeof aiModel>[0]): Promise<void> {
    const { config, model } = aiModel(env);
    await expect(
      generateText({ model, prompt: "hi", maxOutputTokens: config.maxOutputTokens }),
    ).rejects.toThrow();
  }

  it("posts to chat/completions on an OpenAI-compatible endpoint", async () => {
    const spy = captureRequest();
    await generateFrom({ AI_BASE_URL: "https://llm.internal.example/v1/", AI_API_KEY: "k", AI_MODEL: "my-model" });
    expect(spy.url()).toBe("https://llm.internal.example/v1/chat/completions");
    expect(spy.headers().get("authorization")).toBe("Bearer k");
    expect(spy.body().model).toBe("my-model");
    expect(spy.body().max_tokens).toBe(8192);
  });

  it("posts to messages on an Anthropic-compatible endpoint, with x-api-key", async () => {
    const spy = captureRequest();
    await generateFrom({
      AI_PROVIDER: "anthropic",
      AI_BASE_URL: "https://llm.internal.example/anthropic/v1",
      AI_API_KEY: "k",
      AI_MODEL: "claude-opus-4-1",
    });
    expect(spy.url()).toBe("https://llm.internal.example/anthropic/v1/messages");
    expect(spy.headers().get("x-api-key")).toBe("k");
    expect(spy.body().model).toBe("claude-opus-4-1");
    expect(spy.body().max_tokens).toBe(8192);
  });

  it("appends the path to a bare host the user typed without a scheme", async () => {
    const spy = captureRequest();
    await generateFrom({ AI_BASE_URL: "llm.internal.example", AI_API_KEY: "k", AI_MODEL: "m" });
    expect(spy.url()).toBe("https://llm.internal.example/v1/chat/completions");
  });

  it("sends OpenRouter's attribution headers only to OpenRouter", async () => {
    const withRouter = captureRequest();
    await generateFrom({ OPENROUTER_API_KEY: "sk-or-x" });
    expect(withRouter.headers().get("x-title")).toBe("OpenNewsletter");

    const other = captureRequest();
    await generateFrom({ AI_BASE_URL: "https://llm.internal.example/v1", AI_API_KEY: "k", AI_MODEL: "m" });
    expect(other.headers().get("x-title")).toBeNull();
  });

  it("never trusts ANTHROPIC_BASE_URL / OPENAI_BASE_URL from the ambient env", async () => {
    // The SDK providers read those as fallbacks. Reading the process env here
    // instead of the Worker bindings would point production at a developer's
    // laptop, or silently drop the endpoint the operator configured.
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9999");
    vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:9999");
    const spy = captureRequest();
    await generateFrom({ AI_PROVIDER: "anthropic", AI_API_KEY: "k" });
    expect(spy.url()).toBe(`${ANTHROPIC_DEFAULT}/messages`);
  });

  it("resolves nothing usable without a key, with an error that says what to set", () => {
    expect(() => aiModel({ AI_BASE_URL: "https://llm.internal.example/v1" })).toThrow(AiNotConfiguredError);
    expect(() => aiModel({})).toThrow(/AI_API_KEY or OPENROUTER_API_KEY/);
    expect(() => aiModel({})).toThrow(/AI_PROVIDER/);
  });
});

describe("describeAiError", () => {
  const config: AiConfig = {
    protocol: "openai",
    baseURL: "https://llm.internal.example/v1",
    apiKey: "k",
    model: "my-model",
    maxOutputTokens: 8192,
    appTitle: "OpenNewsletter",
  };

  /** The error the SDK actually raises when an endpoint answers non-2xx. */
  function apiError(statusCode: number, responseBody: string): APICallError {
    return new APICallError({
      message: `Response error`,
      url: `${config.baseURL}/chat/completions`,
      requestBodyValues: {},
      statusCode,
      responseBody,
    });
  }

  // These use real provider bodies rather than invented messages: the earlier
  // text-matching version passed on phrases like "Unauthorized" that the
  // endpoints tested against never actually send.
  it("names the key when the endpoint rejects it, quoting the endpoint", () => {
    const openai = describeAiError(
      apiError(401, JSON.stringify({ error: { message: "Incorrect API key provided: sk-***" } })),
      config,
    );
    expect(openai).toContain("rejected the API key");
    expect(openai).toContain("Incorrect API key provided");

    // Anthropic nests the same information differently — an OpenAI-shaped
    // reader would find nothing here.
    const anthropic = describeAiError(
      apiError(401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })),
      config,
    );
    expect(anthropic).toContain("invalid x-api-key");
  });

  it("names the model when the endpoint doesn't serve it", () => {
    const message = describeAiError(
      apiError(404, JSON.stringify({ error: { message: "The model `my-model` does not exist" } })),
      config,
    );
    expect(message).toContain('no model "my-model"');
    expect(message).toContain("does not exist");
  });

  it("reads the status even when the body is not JSON at all", () => {
    // A gateway returning an HTML error page must not be misread as success,
    // nor turn into "[object Object]".
    const message = describeAiError(apiError(502, "<html><body>Bad Gateway</body></html>"), config);
    expect(message).toContain("failed (502)");
    expect(message).toContain("Bad Gateway");
  });

  it("reports a rate limit as such, not as a config error", () => {
    const message = describeAiError(
      apiError(429, JSON.stringify({ error: { message: "Rate limit reached for gpt-4.1" } })),
      config,
    );
    expect(message).toContain("rate-limited");
    expect(message).toContain("Rate limit reached");
  });

  it("names the endpoint when it can't be reached", () => {
    expect(describeAiError(new Error("fetch failed"), config)).toContain("Could not reach https://llm.internal.example/v1");
    expect(describeAiError(new Error("connect ECONNREFUSED 127.0.0.1:9911"), config)).toContain("Could not reach");
  });

  it("passes an unrecognised message through, tagged with the protocol", () => {
    expect(describeAiError(new Error("weird upstream thing"), config)).toBe(
      "openai endpoint error: weird upstream thing",
    );
  });

  it("reports a missing config as configured-but-missing, not as an endpoint fault", () => {
    expect(describeAiError(new AiNotConfiguredError(), config)).toMatch(/AI is not configured/);
  });
});
