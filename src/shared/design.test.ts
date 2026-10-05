// Design tokens end up in style attributes and a <style> block, and arrive
// from the panel, the assistant, agents over the API and DESIGN.md imports.
import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN, applyMobile, cleanTokens, withDefaults } from "./design";

describe("cleanTokens", () => {
  it("keeps real colours in any CSS form and drops anything that isn't one", () => {
    expect(cleanTokens({ colors: { primary: "#0F766E", link: "teal", border: "rgb(1, 2, 3)" } }).colors).toEqual({
      primary: "#0F766E",
      link: "teal",
      border: "rgb(1, 2, 3)",
    });
    const bad = cleanTokens({ colors: { primary: "red}</style><script>alert(1)</script>", link: "red;background:url(x)", page: 7, nope: "#fff" } });
    expect(bad).toEqual({});
  });

  it("clamps numbers to the design panel's range and drops non-numbers", () => {
    expect(cleanTokens({ typography: { titleSize: 4840, baseSize: 2, lineHeight: "1.5", headingWeight: "bold" } }).typography).toEqual({
      titleSize: 72,
      baseSize: 13,
      lineHeight: 1.5,
    });
    expect(cleanTokens({ layout: { contentWidth: Infinity, spacing: null, cardRadius: -4 } }).layout).toEqual({ cardRadius: 0 });
  });

  it("keeps only known fonts and boolean options", () => {
    expect(cleanTokens({ typography: { headingFont: "inter", bodyFont: "Comic Sans" }, options: { showFooter: false, showHeader: "no" } })).toEqual({
      typography: { headingFont: "inter" },
      options: { showFooter: false },
    });
  });

  it("returns nothing for input that isn't a token object", () => {
    for (const v of [null, undefined, "x", 3, [], { colors: "abc" }, { colors: ["#fff"] }]) expect(cleanTokens(v)).toEqual({});
  });

  it("leaves every default token exactly as it is", () => {
    expect(cleanTokens(DEFAULT_DESIGN)).toEqual(DEFAULT_DESIGN);
    expect(withDefaults(DEFAULT_DESIGN)).toEqual(DEFAULT_DESIGN);
  });
});

describe("stored tokens are cleaned wherever they're read", () => {
  it("withDefaults falls back to the default for a bad value", () => {
    const d = withDefaults({ colors: { primary: "}</style>" } } as any);
    expect(d.colors.primary).toBe(DEFAULT_DESIGN.colors.primary);
  });

  it("applyMobile ignores a bad mobile override", () => {
    const m = applyMobile(DEFAULT_DESIGN, { colors: { background: "red}</style><script>" }, typography: { titleSize: 999 } } as any);
    expect(m.colors.background).toBe(DEFAULT_DESIGN.colors.background);
    expect(m.typography.titleSize).toBe(72);
  });
});
