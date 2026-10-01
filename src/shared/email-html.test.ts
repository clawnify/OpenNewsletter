import { describe, expect, it } from "vitest";
import { balanceTags, cleanEmailHtml } from "./email-html";

describe("cleanEmailHtml", () => {
  it("drops scripts, embeds, event handlers and script URLs", () => {
    const out = cleanEmailHtml(
      `<p onclick="x()" style="color:red">Hi</p><script>alert(1)</script><iframe src="https://e.example"></iframe>` +
        `<a href="javascript:alert(1)">a</a><img src=x onerror=alert(1)><meta http-equiv="refresh" content="0">`,
    );
    expect(out).toBe(`<p style="color:red">Hi</p><a href="#">a</a><img src=x>`);
  });

  it("drops an unclosed script along with everything it would swallow", () => {
    expect(cleanEmailHtml(`<p>ok</p><script>alert(1)`)).toBe("<p>ok</p>");
  });

  it("keeps Outlook conditional comments", () => {
    const mso = `<!--[if mso]><table><tr><td width="600"><![endif]--><div>x</div><!--[if mso]></td></tr></table><![endif]-->`;
    expect(cleanEmailHtml(mso)).toBe(mso);
  });
});

describe("balanceTags", () => {
  it("closes what was left open and drops closers never opened", () => {
    expect(balanceTags(`<table><tr><td>a`)).toBe(`<table><tr><td>a</td></tr></table>`);
    expect(balanceTags(`a</div></td></tr></table>b`)).toBe("ab");
  });

  it("closes inner elements a closer skips over, and leaves void elements alone", () => {
    expect(balanceTags(`<div><span>x<br><img src="a"/></div>`)).toBe(`<div><span>x<br><img src="a"/></span></div>`);
  });
});
