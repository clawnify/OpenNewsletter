import { describe, expect, it } from "vitest";
import { renderEmailHtml } from "./render";
import { DEFAULT_DESIGN } from "../shared/design";
import { renderBlock } from "../shared/email-blocks";
import type { Block, Mail, Settings } from "../shared/types";

const settings: Settings = { publication_name: "Pub", logo: "", from_name: "", from_email: "a@b.co", senders: [], default_audience_id: null, footer_text: "", crm_app_id: null } as Settings;

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

describe("html blocks", () => {
  it("send the same email as the block they were converted from", () => {
    const blocks: Block[] = [
      text("Some **bold** and a [link](https://example.com)."),
      { id: "b", type: "button", text: "Go", href: "https://example.com", align: "center" },
      { id: "c", type: "columns", items: [{ image: "https://example.com/a.png", heading: "A", text: "a" }, { image: "", heading: "B", text: "b" }] } as Block,
    ];
    const converted = blocks.map((b): Block => ({ id: b.id, type: "html", html: renderBlock(b, DEFAULT_DESIGN) }));
    expect(renderEmailHtml(mail(converted), DEFAULT_DESIGN, settings)).toBe(renderEmailHtml(mail(blocks), DEFAULT_DESIGN, settings));
  });

  it("fill merge tags as escaped text, but never inside a URL attribute", () => {
    const html = renderEmailHtml(
      mail([{ id: "h", type: "html", html: `<td>Hi {{first_name|there}}</td><a href="{{first_name}}">x</a><img src='{{ email }}'>` } as Block]),
      DEFAULT_DESIGN, settings, { merge: { first_name: `<b>"Ann"</b>`, last_name: "", email: "javascript:alert(1)" } },
    );
    expect(html).toContain("Hi &lt;b&gt;&quot;Ann&quot;&lt;/b&gt;");
    expect(html).toContain(`href="{{first_name}}"`);
    expect(html).toContain(`src='{{ email }}'`);
  });

  it("stay inside their own row when the snippet is broken", () => {
    const html = renderEmailHtml(mail([{ id: "h", type: "html", html: "<table><tr><td>open" } as Block, text("after")]), DEFAULT_DESIGN, settings);
    expect(html).toMatch(/<td>open<\/td><\/tr><\/table><\/td><\/tr><tr><td[^>]*><div class="nl-text"[^>]*><p[^>]*>after/);
  });
});

// Every block type with no styling set. A send retries under idempotency keys
// and must render exactly as it first did, so if this snapshot changes for an
// existing block, bump the send snapshot's `renderer` (src/server/sending.ts).
describe("existing blocks render unchanged", () => {
  it("matches the snapshot", () => {
    const all = [
      { id: "a", type: "heading", level: 1, text: "Title" }, { id: "b", type: "heading", level: 2, text: "H2", align: "center" },
      { id: "c", type: "text", md: "Body **b** [l](https://x.y)", color: "secondary", scale: 0.82, uppercase: true },
      { id: "d", type: "image", src: "https://x.y/i.png", alt: "alt", caption: "cap", href: "https://x.y" },
      { id: "f", type: "button", text: "Go", href: "https://x.y", align: "center" },
      { id: "g", type: "list", ordered: true, items: ["one", "two"] }, { id: "h", type: "quote", text: "q", cite: "c" },
      { id: "i", type: "divider" }, { id: "j", type: "spacer", size: 24 },
      { id: "k", type: "columns", items: [{ image: "https://x.y/a.png", heading: "A", text: "a" }, { image: "", heading: "B", text: "b" }] },
      { id: "l", type: "html", html: "<table><tr><td>x {{first_name}}</td></tr></table>" },
    ] as Block[];
    expect(renderEmailHtml(mail(all, "pre"), DEFAULT_DESIGN, settings, { merge: values("Ada") })).toMatchSnapshot();
  });
});

describe("block styling", () => {
  const dark = { ...DEFAULT_DESIGN, colors: { ...DEFAULT_DESIGN.colors, foreground: "#111111" } };

  it("puts a block in a coloured section and keeps its text readable there", () => {
    const html = renderBlock({ id: "t", type: "text", md: "Hi", box: { background: "#111827" } } as Block, dark);
    expect(html).toMatch(/^<table[^>]*><tr><td bgcolor="#111827" style="background:#111827;padding:24px;/);
    expect(html).toContain("color:#FFFFFF");
  });

  it("keeps padding 0 on a coloured section, and renders bare with no colour and no padding", () => {
    expect(renderBlock({ id: "t", type: "divider", box: { background: "primary", padding: 0 } } as Block, dark)).toContain(`padding:0px;`);
    const bare = renderBlock({ id: "t", type: "divider" } as Block, dark);
    expect(renderBlock({ id: "t", type: "divider", box: { padding: 0 } } as Block, dark)).toBe(bare);
  });

  it("ignores a background that is neither a design colour nor a hex value", () => {
    expect(renderBlock({ id: "t", type: "divider", box: { background: "red;x:expression(1)" } } as Block, dark)).not.toContain("expression");
  });

  it("sizes and aligns an image, with a pixel width for Outlook", () => {
    const html = renderBlock({ id: "i", type: "image", src: "https://x.y/i.png", alt: "", caption: "", href: "", width: 50, align: "left" } as Block, DEFAULT_DESIGN);
    expect(html).toContain(`width="${DEFAULT_DESIGN.layout.contentWidth / 2}" style="width:50%;`);
    expect(html).toContain("text-align:left");
  });

  it("draws outline and full-width buttons", () => {
    const outline = renderBlock({ id: "b", type: "button", text: "Go", href: "https://x.y", align: "left", variant: "outline" } as Block, DEFAULT_DESIGN);
    expect(outline).toContain(`border:2px solid ${DEFAULT_DESIGN.colors.primary}`);
    expect(outline).not.toContain("bgcolor");
    const full = renderBlock({ id: "b", type: "button", text: "Go", href: "https://x.y", align: "left", fullWidth: true } as Block, DEFAULT_DESIGN);
    expect(full).toContain(`width="100%"`);
    expect(full).toContain("display:block");
  });
});
