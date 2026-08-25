/**
 * Generation-first authoring. A prompt → a structured editorial draft
 * ({ eyebrow, title, subtitle, body_md }). Uses OpenRouter with the
 * org's injected OPENROUTER_API_KEY (the platform standard); the model
 * is overridable via NEWSLETTER_MODEL.
 */

const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

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

export async function generateDraft(env: Record<string, string>, input: GenInput): Promise<GenDraft> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("AI generation unavailable: OPENROUTER_API_KEY is not set.");
  const model = env.NEWSLETTER_MODEL || DEFAULT_MODEL;

  const userParts: string[] = [];
  if (input.publication) userParts.push(`Publication: ${input.publication}`);
  if (input.current?.title || input.current?.body_md) {
    userParts.push(
      `Revise this existing draft per the instruction below.\n\nCurrent title: ${input.current.title || ""}\nCurrent body:\n${input.current.body_md || ""}`,
    );
  }
  userParts.push(`Instruction: ${input.prompt}`);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://clawnify.com",
      "X-Title": "OpenNewsletter",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userParts.join("\n\n") },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content.");

  const parsed = parseDraft(content);
  return {
    eyebrow: parsed.eyebrow?.trim() || "",
    title: parsed.title?.trim() || "Untitled",
    subtitle: parsed.subtitle?.trim() || "",
    body_md: parsed.body_md?.trim() || "",
  };
}

/** Low-level single-shot completion (plain text out). */
export async function completeText(env: Record<string, string>, system: string, user: string): Promise<string> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("AI generation unavailable: OPENROUTER_API_KEY is not set.");
  const model = env.NEWSLETTER_MODEL || DEFAULT_MODEL;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://clawnify.com",
      "X-Title": "OpenNewsletter",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenRouter returned no content.");
  return content.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
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
  env: Record<string, string>,
  prompt: string,
  sections: BatchSection[],
  publication?: string,
): Promise<Record<string, string>> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("AI generation unavailable: OPENROUTER_API_KEY is not set.");
  const model = env.NEWSLETTER_MODEL || DEFAULT_MODEL;

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

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://clawnify.com",
      "X-Title": "OpenNewsletter",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content || "{}";
  const cleaned = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    return a >= 0 && b > a ? JSON.parse(cleaned.slice(a, b + 1)) : {};
  }
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
export async function generateField(env: Record<string, string>, input: FieldInput): Promise<string> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("AI generation unavailable: OPENROUTER_API_KEY is not set.");
  const model = env.NEWSLETTER_MODEL || DEFAULT_MODEL;

  const ctx = [
    input.publication ? `Publication: ${input.publication}` : "",
    `Current title: ${input.context.title}`,
    input.context.subtitle ? `Current subtitle: ${input.context.subtitle}` : "",
    input.field === "body" ? "" : `Current body:\n${input.context.body_md}`,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://clawnify.com",
      "X-Title": "OpenNewsletter",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: `You are an expert newsletter editor. ${FIELD_GUIDANCE[input.field]}` },
        { role: "user", content: `${ctx}\n\nInstruction: ${input.prompt}` },
      ],
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenRouter returned no content.");
  // Strip accidental code fences / surrounding quotes for short fields.
  const cleaned = content.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  return input.field === "body" ? cleaned : cleaned.replace(/^["']|["']$/g, "");
}

/** Tolerant JSON extraction — strips code fences / surrounding prose. */
function parseDraft(content: string): Partial<GenDraft> {
  const cleaned = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
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
    // Last resort: treat the whole thing as the body.
    return { body_md: content };
  }
}
