import chroma from "chroma-js";

/**
 * Pick a readable text color for a given background using chroma-js
 * contrast ratios. Returns near-white or near-black — whichever has the
 * higher WCAG contrast against `bg`. Used for button labels so the user
 * never has to hand-set "text on primary".
 */
export function readableTextOn(bg: string): string {
  try {
    const light = "#FFFFFF";
    const dark = "#111111";
    return chroma.contrast(bg, light) >= chroma.contrast(bg, dark) ? light : dark;
  } catch {
    return "#FFFFFF";
  }
}

/** `color` when it reads on `bg` (WCAG AA for body text), otherwise near-white or near-black. */
export function readableOr(color: string, bg: string): string {
  try {
    return chroma.contrast(bg, color) >= 4.5 ? color : readableTextOn(bg);
  } catch {
    return color;
  }
}
