---
version: alpha
name: Classic Editorial
description: The default newsletter brand for OpenNewsletter. A quiet, editorial look — serif headlines, generous line-height, a single accent color for rules and buttons. Each issue and each saved template carries its own DESIGN.md tokens that override these.
colors:
  background: "#FFFFFF"
  foreground: "#111111"
  primary: "#DB2777"
  onPrimary: "#FFFFFF"
  secondary: "#6B7280"
  link: "#4746E5"
  border: "#E5E7EB"
typography:
  headingFont: newsreader
  bodyFont: newsreader
  baseSize: 17px
  titleSize: 40px
  lineHeight: 1.65
  headingWeight: 600
layout:
  contentWidth: 600px
  spacing: 24px
  radius: 8px
options:
  showHeader: true
  showFeatureImage: true
  showByline: true
  showDivider: true
  showFooter: true
---

# Classic Editorial

The platform-default brand for newsletters created in **OpenNewsletter**.
The format follows [Google Labs' DESIGN.md spec](https://github.com/google-labs-code/design.md):
tokens in the YAML frontmatter give the renderer exact values; the prose
below explains *when* to use each token and when to deviate.

This file is the **runtime mirror** of `DEFAULT_DESIGN` in
`src/shared/design.ts`. The studio's right-hand design panel edits these
tokens live; "Save as.." exports the current tokens back into this format
(see `serializeDesign`).

## Overview

The default style is **editorial and quiet**: a serif face (Newsreader)
for both headline and body, a single accent color (`primary`) used only
for the title rule and call-to-action buttons, and a 600px column that
renders identically in every email client. Newsletters should read like a
well-set magazine column, not a marketing blast.

## Colors

Seven tokens. The panel's **Basic → Colors** group edits the first six;
`border` lives under **Advanced → Layout**.

| Token | Default | Used for |
|---|---|---|
| `background` | `#FFFFFF` | Email/page surface. Never used for type. |
| `foreground` | `#111111` | Title and body text. |
| `primary` | `#DB2777` | Title rule, buttons, the publication eyebrow. |
| `onPrimary` | `#FFFFFF` | Text on a `primary` button. |
| `secondary` | `#6B7280` | Deck, byline, captions, footer. |
| `link` | `#4746E5` | Inline links in body copy. |
| `border` | `#E5E7EB` | Hairline dividers. |

Recolor by editing `primary` — it is the only chromatic token. Everything
else is grayscale by default so the accent reads cleanly.

## Typography

Two font slots (`headingFont`, `bodyFont`) chosen from a curated,
email-safe list (`FONTS` in `src/shared/design.ts`). The editorial default
uses the same serif for both. `titleSize` is the desktop hero size; the
renderer steps it down on mobile.

## Layout & Sections

`contentWidth` stays inside 480–680px for email-client compatibility.
The `options` toggles control which blocks render: the publication
**header** (eyebrow), the **feature image**, the **byline**, the title
**divider**, and the **footer** (publication name + unsubscribe). Turning a
section off removes it from both the preview and the sent email.

## Do's and Don'ts

**Do** recolor via `primary`. **Do** keep `contentWidth` ≤ 680.
**Don't** add new color tokens — edit the existing seven.
**Don't** hardcode a brand color in a component; it belongs here.
