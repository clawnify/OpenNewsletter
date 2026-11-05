// The editing ops both assistants share. What these pin: each op changes only
// what it says, a missing block is an error rather than a silent no-op, and the
// subject an op sets survives the next save (the subject is derived from the
// top heading on every block write).
import { describe, expect, it } from "vitest";
import { applyMailOp, mailOutline } from "./mail-ops";
import { deriveTitle } from "./blocks";
import { DEFAULT_DESIGN } from "./design";
import type { Block } from "./types";

const base = DEFAULT_DESIGN;
const blocks: Block[] = [
  { id: "h", type: "heading", level: 1, text: "Old headline" } as Block,
  { id: "t", type: "text", md: "First paragraph" } as Block,
  { id: "btn", type: "button", text: "Read", href: "https://a.example" } as Block,
];
const mail = { blocks, title: "Old headline" };

describe("applyMailOp", () => {
  it("edit_block rewrites one block in place, keeping its type", () => {
    const r = applyMailOp(mail, "edit_block", { block_id: "t", text: "New copy" }, { base });
    expect(r.ok && r.patch.blocks).toEqual([blocks[0], { id: "t", type: "text", md: "New copy" }, blocks[2]]);
  });

  it("a missing block is an error, not a silent no-op", () => {
    expect(applyMailOp(mail, "edit_block", { block_id: "nope", text: "x" }, { base }).ok).toBe(false);
    expect(applyMailOp(mail, "remove_block", { block_id: "nope" }, { base }).ok).toBe(false);
    expect(applyMailOp(mail, "style_block", { block_id: "nope", padding: 8 }, { base }).ok).toBe(false);
  });

  it("set_title changes the top heading, so the subject survives the next block save", () => {
    const r = applyMailOp(mail, "set_title", { title: "Shipped this week" }, { base });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.title).toBe("Shipped this week");
    expect(deriveTitle(r.patch.blocks!)).toBe("Shipped this week");
  });

  it("set_title on an issue with no heading is refused, since nothing would keep that subject", () => {
    const r = applyMailOp({ blocks: [blocks[1]], title: "" }, "set_title", { title: "Hi" }, { base });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no heading");
  });

  it("a mobile design change joins the mobile overrides already there", () => {
    const r = applyMailOp({ ...mail, design_mobile: { typography: { baseSize: 15 } } as any }, "set_design", { key: "colors.primary", value: "#112233" }, { base, device: "mobile" });
    expect(r.ok && r.patch.design_mobile).toEqual({ colors: { primary: "#112233" }, typography: { baseSize: 15 } });
  });

  it("set_content replaces the body and derives the subject from it", () => {
    const r = applyMailOp(mail, "set_content", { markdown: "# Fresh\n\nBody" }, { base });
    expect(r.ok && r.patch.title).toBe("Fresh");
  });

  it("set_design refuses a key outside the allow-list, and stores a mobile change as an override", () => {
    expect(applyMailOp(mail, "set_design", { key: "colors.evil", value: "x" }, { base }).ok).toBe(false);
    const r = applyMailOp(mail, "set_design", { key: "colors.primary", value: "#112233" }, { base, device: "mobile" });
    expect(r.ok && r.patch).toEqual({ design_mobile: { colors: { primary: "#112233" } } });
  });

  it("set_design reaches the text colour, clamps numbers, and refuses a value the design can't use", () => {
    const fg = applyMailOp(mail, "set_design", { key: "colors.foreground", value: "#222222" }, { base });
    expect(fg.ok && fg.patch.design?.colors.foreground).toBe("#222222");
    const radius = applyMailOp(mail, "set_design", { key: "layout.buttonRadius", value: 999 }, { base });
    expect(radius.ok && radius.patch.design!.layout.buttonRadius).toBeLessThan(999);
    const bad = applyMailOp(mail, "set_design", { key: "colors.primary", value: "red}</style>" }, { base });
    expect(bad).toEqual({ ok: false, message: '"red}</style>" isn\'t a usable value for colors.primary.' });
  });

  it("an unknown op is refused", () => {
    expect(applyMailOp(mail, "send_to_everyone", {}, { base })).toEqual({ ok: false, message: "Unknown tool: send_to_everyone" });
  });

  it("the outline lists every block by id", () => {
    expect(mailOutline(blocks)).toBe('[h] heading: Old headline (h1)\n[t] text: First paragraph\n[btn] button: button "Read"');
    expect(mailOutline([])).toBe("(empty)");
  });
});
