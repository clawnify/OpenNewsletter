import { describe, expect, it } from "vitest";
import { renderEmailHtml } from "./render";
import { DEFAULT_DESIGN } from "../shared/design";
import type { Block, Mail, Settings } from "../shared/types";

const settings: Settings = { publication_name: "Pub", logo: "", from_name: "", from_email: "a@b.co", senders: [], default_audience_id: null, footer_text: "" } as Settings;

function mail(blocks: Block[], preheader = ""): Mail {
  return {
    id: 1, eyebrow: "", title: "Issue", preheader, subtitle: "", byline_name: "", byline_date: "", feature_image: "",
    blocks, design: null, design_mobile: null, template_slug: null, audience_id: null, status: "draft",
    broadcast_id: null, scheduled_at: null, sent_at: null, created_at: "", updated_at: "",
  } as Mail;
}

const text = (md: string): Block => ({ id: "t", type: "text", md });
const values = (first_name: string) => ({ first_name, last_name: "", email: "x@example.com" });

describe("merge tags", () => {
  it("fills text, headings and buttons, with the fallback for an empty value", () => {
    const blocks: Block[] = [
      { id: "h", type: "heading", level: 2, text: "For {{first_name}}" },
      text("Hi {{ first_name | there }}, you're on as {{email}}."),
      { id: "b", type: "button", text: "Go, {{first_name|friend}}", href: "https://example.com", align: "left" },
    ];
    const html = renderEmailHtml(mail(blocks), DEFAULT_DESIGN, settings, { merge: values("") });
    expect(html).toContain(">For </h2>");
    expect(html).toContain("Hi there, you're on as x@example.com.");
    expect(html).toContain(">Go, friend</a>");
  });

  // Names come from a public signup form: a value is text, never markup.
  it("never lets a value add markup or a link", () => {
    const html = renderEmailHtml(mail([text("Hi **{{first_name}}**")]), DEFAULT_DESIGN, settings, {
      merge: values(`[Claim](https://evil.example) <img src=x onerror=1> "q"`),
    });
    expect(html).not.toContain("https://evil.example\"");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("<strong style=\"font-weight:700;\">[Claim](https://evil.example) &lt;img src=x onerror=1&gt; &quot;q&quot;</strong>");
  });

  it("reads Klaviyo's and Liquid's default filter as the fallback", () => {
    const html = renderEmailHtml(mail([text(`A {{ first_name|default:'friend' }}, B {{ first_name | default: "there" }}, C {{last_name|default:}}.`)]), DEFAULT_DESIGN, settings, { merge: values("") });
    expect(html).toContain("A friend, B there, C .");
  });

  it("leaves tags as written without values, and unknown tags always", () => {
    const blocks = [text("Hi {{first_name|there}} {{company}}")];
    expect(renderEmailHtml(mail(blocks), DEFAULT_DESIGN, settings)).toContain("Hi {{first_name|there}} {{company}}");
    expect(renderEmailHtml(mail(blocks), DEFAULT_DESIGN, settings, { merge: values("Ada") })).toContain("Hi Ada {{company}}");
  });

  it("never fills a tag that opens a link or image target, so a reader can't choose the URL", () => {
    const html = renderEmailHtml(mail([text("[Go]({{first_name}}) ![i]( {{last_name}}) [Q](https://a.example/?n={{first_name}})")]), DEFAULT_DESIGN, settings, {
      merge: { first_name: "javascript:alert(1)", last_name: "https://evil.example/x.png", email: "" },
    });
    expect(html).toContain('href="{{first_name}}"');
    expect(html).not.toContain("evil.example");
    expect(html).toContain('href="https://a.example/?n=javascript:alert(1)"');
  });
});

describe("preheader", () => {
  it("is the hidden first child of the body, padded so body text doesn't follow it", () => {
    const html = renderEmailHtml(mail([text("CHANGELOG")], "Three fixes, {{first_name|friend}}"), DEFAULT_DESIGN, settings, { merge: values("Ada") });
    const body = html.slice(html.indexOf("<body"));
    const first = body.slice(body.indexOf(">") + 1).trimStart();
    expect(first.startsWith('<div style="display:none;')).toBe(true);
    expect(first).toMatch(/^<div[^>]*>Three fixes, Ada(&zwnj;&nbsp;)+<\/div>/);
  });

  it("is left out when empty", () => {
    expect(renderEmailHtml(mail([text("x")], "  "), DEFAULT_DESIGN, settings)).not.toContain("display:none");
  });
});

describe("columns", () => {
  it("lines the outer cells up with the body text and pads only the gutters", () => {
    const html = renderEmailHtml(mail([{ id: "c", type: "columns", items: [
      { image: "", heading: "A", text: "a" }, { image: "", heading: "B", text: "b" }, { image: "", heading: "C", text: "c" },
    ] } as Block]), DEFAULT_DESIGN, settings);
    const pads = [...html.matchAll(/class="nl-col"[^>]*padding:([^;]+);/g)].map((m) => m[1]);
    expect(pads).toEqual(["0 0 0 0px", "0 0 0 16px", "0 0 0 16px"]);
  });
});
