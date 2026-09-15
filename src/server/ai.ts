/**
 * Generation-first authoring. A prompt → a structured editorial draft
 * ({ eyebrow, title, subtitle, body_md }).
 *
 * The model comes from ./llm.ts, which reads the endpoint out of the
 * environment — any OpenAI- or Anthropic-compatible API, so nothing here is
 * tied to one vendor.
 */
import { generateText } from "ai";
import { aiModel, describeAiError, type AiEnv } from "./llm";

/** Sampling temperature shared by every generation call. */
const TEMPERATURE = 0.7;

export interface GenInput {
  prompt: string;
  /** Optional steer: publication name, audience, tone. */
  publication?: string;
  /** Existing draft to revise instead of starting fresh. */
  current?: { title?: string; body_md?: string } | null;
}

export interface GenDraft {
  eyebrow: string;
  title: string;
  subtitle: string;
  body_md: string;
}

const SYSTEM = `You are an expert newsletter editor. You write a single newsletter mail as clean, scannable editorial prose.

Output rules:
- Respond with ONLY a JSON object, no prose around it, no code fences.
- Shape: { "eyebrow": string, "title": string, "subtitle": string, "body_md": string }
- "eyebrow": a short kicker like "WEEKLY DIGEST · ISSUE 12" (<= 40 chars). Use the publication name if given.
- "title": a compelling headline (<= 80 chars). No trailing period.
- "subtitle": one-sentence deck/standfirst that expands the title.
- "body_md": the mail body in Markdown. Use ## and ### for sections, short paragraphs, occasional bullet lists, and at most one > blockquote pull-quote. Do NOT include the title or subtitle in the body. Do NOT add a sign-off/unsubscribe (the template adds the footer). Aim for 250-500 words unless the prompt asks otherwise.`;

/**
 * One completion from the configured endpoint. The single place a model is
 * called, so every generation path shares the same settings and the same
 * error translation.
 */
async function generate(env: AiEnv, req: { system: string; prompt: string }): Promise<string> {
  const { config, model } = aiModel(env);
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model,
      system: req.system,
      prompt: req.prompt,
      temperature: TEMPERATURE,
      // A whole newsletter comes back in one response, and endpoints that
      // don't recognise the model id fall back to a few-thousand-token
      // ceiling — which silently truncates the body mid-sentence.
      maxOutputTokens: config.maxOutputTokens,
    });
  } catch (e) {
    // Endpoint misconfiguration is the common failure now, so name the
    // endpoint and model instead of echoing a raw upstream body.
    throw new Error(describeAiError(e, config));
  }
  if (result.finishReason === "length") {
    throw new Error(
      `The response was cut off at the ${config.maxOutputTokens}-token ceiling. Shorten the request or raise maxOutputTokens in server/llm.ts.`,
    );
  }
  const text = result.text.trim();
  if (!text) throw new Error(`The endpoint at ${config.baseURL} returned an empty response.`);
  return text;
}

/** Models sometimes wrap output in a code fence despite being told not to. */
function stripFences(s: string): string {
  return s.replace(/^```[a-z]*\n?|\n?```$/gi, "").trim();
}

/** Tolerant JSON-object extraction — strips code fences / surrounding prose. */
function parseJsonObject(text: string): Record<string, string> {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    return a >= 0 && b > a ? JSON.parse(cleaned.slice(a, b + 1)) : {};
  }
}

export async function generateDraft(env: AiEnv, input: GenInput): Promise<GenDraft> {
  const userParts: string[] = [];
  if (input.publication) userParts.push(`Publication: ${input.publication}`);
  if (input.current?.title || input.current?.body_md) {
    userParts.push(
      `Revise this existing draft per the instruction below.\n\nCurrent title: ${input.current.title || ""}\nCurrent body:\n${input.current.body_md || ""}`,
    );
  }
  userParts.push(`Instruction: ${input.prompt}`);

  const parsed = parseDraft(await generate(env, { system: SYSTEM, prompt: userParts.join("\n\n") }));
  return {
    eyebrow: parsed.eyebrow?.trim() || "",
    title: parsed.title?.trim() || "Untitled",
    subtitle: parsed.subtitle?.trim() || "",
    body_md: parsed.body_md?.trim() || "",
  };
}

/** Low-level single-shot completion (plain text out). */
export async function completeText(env: AiEnv, system: string, user: string): Promise<string> {
  return stripFences(await generate(env, { system, prompt: user }));
}

// ── Multi-block batch rewrite (structured per-section output) ────────

export interface BatchSection {
  id: string;
  type: string;
  current: string;
}

/**
 * Rewrite several selected sections at once, returning a map of
 * blockId → new content. The model is told the type of each section so
 * it returns Markdown for text, plain lines for lists, a single line
 * otherwise.
 */
export async function rewriteBatch(
  env: AiEnv,
  prompt: string,
  sections: BatchSection[],
  publication?: string,
): Promise<Record<string, string>> {
  const system = `You are an expert newsletter editor. You will be given several SECTIONS of one newsletter, each with an id and a type. Rewrite each section per the instruction so they read as a coherent whole.

Return ONLY a JSON object mapping each section id to its new content:
{ "<id>": "<new content>", ... }

Content rules by type:
- "text": Markdown (one or more short paragraphs).
- "list": the items separated by newlines, no bullets or numbers.
- "heading" / "quote" / "button": a single short plain-text line.`;

  const user = [
    publication ? `Publication: ${publication}` : "",
    "Sections:",
    ...sections.map((s) => `[id: ${s.id}] (${s.type})\n${s.current}`),
    `\nInstruction: ${prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return parseJsonObject(await generate(env, { system, prompt: user }));
}

// ── Single-field (re)generation ──────────────────────────────────────

const FIELD_GUIDANCE: Record<string, string> = {
  title: "Write ONE compelling newsletter headline (<= 80 chars, no trailing period). Output only the headline text, nothing else.",
  subtitle: "Write ONE deck/standfirst sentence that expands the headline. Output only that sentence.",
  eyebrow: "Write a short kicker/eyebrow label (<= 40 chars), e.g. 'WEEKLY DIGEST · ISSUE 12'. Output only the label.",
  body: "Write the newsletter BODY in Markdown (## / ### headings, short paragraphs, optional bullet list, at most one > pull-quote). Do NOT include the title or a sign-off. Output only the Markdown body.",
};

export interface FieldInput {
  field: "title" | "subtitle" | "eyebrow" | "body";
  prompt: string;
  publication?: string;
  context: { title: string; subtitle: string; eyebrow: string; body_md: string };
}

/** Regenerate a single field, given the rest of the mail as context. */
export async function generateField(env: AiEnv, input: FieldInput): Promise<string> {
  const ctx = [
    input.publication ? `Publication: ${input.publication}` : "",
    `Current title: ${input.context.title}`,
    input.context.subtitle ? `Current subtitle: ${input.context.subtitle}` : "",
    input.field === "body" ? "" : `Current body:\n${input.context.body_md}`,
  ]
    .filter(Boolean)
    .join("\n");

  const text = await generate(env, {
    system: `You are an expert newsletter editor. ${FIELD_GUIDANCE[input.field]}`,
    prompt: `${ctx}\n\nInstruction: ${input.prompt}`,
  });
  // Strip accidental code fences / surrounding quotes for short fields.
  const cleaned = stripFences(text);
  return input.field === "body" ? cleaned : cleaned.replace(/^["']|["']$/g, "");
}

/** Tolerant JSON extraction — strips code fences / surrounding prose. */
function parseDraft(content: string): Partial<GenDraft> {
  const cleaned = stripFences(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    // Last resort: treat the whole thing as the body. Models that ignore the
    // JSON instruction still return usable prose, and losing the draft
    // entirely is worse than a draft with no eyebrow or title.
    return { body_md: cleaned };
  }
}
