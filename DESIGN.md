---
name: "Peetty"
description: "An anime character messenger with rig portraits and character image colours."
colors:
  violet: "#6a58e0"
  violet-end: "#9a4fd3"
  violet-light: "#b9afff"
  pink: "#d02f74"
  pink-end: "#b845b0"
  pink-light: "#ff9dc0"
  red: "#d43545"
  red-end: "#c8491f"
  red-light: "#ffa0a3"
  orange: "#bd5008"
  orange-end: "#a8650a"
  orange-light: "#ffb37c"
  green: "#148049"
  green-end: "#0d7f78"
  green-light: "#7fdcaa"
  teal: "#0c7f8f"
  teal-end: "#2a70c9"
  teal-light: "#72d6e2"
  blue: "#2d6bd8"
  blue-end: "#5a5fdc"
  blue-light: "#9bbdff"
  bg: "color-mix(in srgb, var(--pc-color) 5%, #fff)"
  input: "#fff"
  ink: "#2a2b47"
  muted: "#636786"
  error: "#b8203f"
  accent: "color-mix(in srgb, var(--pc-color) 80%, #17172e)"
  soft: "color-mix(in srgb, var(--pc-color) 11%, #fff)"
  line: "color-mix(in srgb, var(--pc-color) 18%, #e9e9f0)"
  line-strong: "color-mix(in srgb, var(--pc-color) 35%, #9a9cb5)"
  bg-dark: "color-mix(in srgb, var(--pc-color) 7%, #131322)"
  input-dark: "color-mix(in srgb, var(--pc-color) 10%, #1d1d31)"
  ink-dark: "#eeedf7"
  muted-dark: "#a5a7c4"
  error-dark: "#ff9db0"
  accent-dark: "var(--pc-light)"
  soft-dark: "color-mix(in srgb, var(--pc-color) 22%, #1a1a2d)"
  line-dark: "color-mix(in srgb, var(--pc-color) 24%, #303044)"
  line-strong-dark: "color-mix(in srgb, var(--pc-light) 38%, #4a4c6c)"
  white: "#fff"
  portrait-ground: "#f5f1ff"
  accent-mix-base: "#17172e"
  mask-opaque: "#000"
  status-overlay: "rgb(0 0 0 / .18)"
  icon-overlay: "rgb(0 0 0 / .12)"
  icon-hover-overlay: "rgb(0 0 0 / .25)"
typography:
  mobile-title:
    fontFamily: "ui-rounded, 'Hiragino Maru Gothic ProN', 'Yuanti SC', system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 750
    lineHeight: 1.2
  mobile-input:
    fontFamily: "system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  headline:
    fontFamily: "ui-rounded, 'Hiragino Maru Gothic ProN', 'Yuanti SC', system-ui, sans-serif"
    fontSize: "23px"
    fontWeight: 750
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  title:
    fontFamily: "ui-rounded, 'Hiragino Maru Gothic ProN', 'Yuanti SC', system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  setup-title:
    fontFamily: "ui-rounded, 'Hiragino Maru Gothic ProN', 'Yuanti SC', system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 750
    lineHeight: 1.4
  section:
    fontFamily: "ui-rounded, 'Hiragino Maru Gothic ProN', 'Yuanti SC', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  dialogue:
    fontFamily: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.75
  body-ui:
    fontFamily: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.6
  byline:
    fontFamily: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "11px"
    fontWeight: 650
    lineHeight: 1.4
  status:
    fontFamily: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  bubble-tail: "4px"
  input: "10px"
  bubble: "17px"
  pill: "20px"
  frame: "22px"
  primary: "24px"
  composer: "26px"
  circle: "50%"
spacing:
  tight: "6px"
  control: "10px"
  field: "16px"
  conversation-inline: "18px"
  message: "20px"
  header: "22px"
components:
  button-primary:
    backgroundColor: "{colors.violet}"
    textColor: "{colors.white}"
    rounded: "{rounded.primary}"
    padding: "12px 16px"
    height: "44px"
  button-small:
    backgroundColor: "{colors.input}"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
    height: "36px"
  link:
    textColor: "{colors.accent}"
    padding: "6px 0"
  input:
    backgroundColor: "{colors.input}"
    textColor: "{colors.ink}"
    rounded: "{rounded.input}"
    padding: "10px 12px"
    height: "42px"
    typography: "{typography.body-ui}"
  composer:
    backgroundColor: "{colors.input}"
    rounded: "{rounded.composer}"
    padding: "5px"
  tab-active:
    backgroundColor: "{colors.violet}"
    textColor: "{colors.white}"
    rounded: "{rounded.frame}"
    height: "38px"
    padding: "8px 10px"
  dialogue:
    backgroundColor: "{colors.input}"
    textColor: "{colors.ink}"
    typography: "{typography.dialogue}"
    padding: "12px 15px"
  status:
    textColor: "{colors.white}"
    backgroundColor: "rgb(0 0 0 / .18)"
    rounded: "{rounded.pill}"
    typography: "{typography.status}"
    padding: "3px 8px"
---

# Design System: Peetty

## Overview

**Creative North Star: "The Character Messenger"**

The popup is an anime game character messenger (角色通讯). The companion lends her face and image colour (印象色) to the interface: a bright gradient header, manga screentone, rounded dialogue bubbles and pill controls. Her rig portrait looks away while thinking and moves its mouth while replying.

This system governs the embedded chat and settings popup, not the hosted site or the pet’s speech bubble. It remains browser-only, with local system fonts and inline SVG artwork; no external font or portrait asset is required. Dark mode follows the device preference and uses character-tinted night surfaces.

**Key Characteristics:**

- Character identity comes from her rig and image colour.
- A gradient, screentone dots and slanted stripes distinguish the header.
- Companion bubbles use the input surface; user bubbles use the character fill and white text.
- Round portraits, pill actions and four-point sparkles repeat across chat and settings.

## Colors

Seven saturated character families supply a fill, gradient end and light accent. The frontmatter’s violet component samples represent the default; live controls follow the selected character variables.

### Primary

Miru uses violet, Koharu orange, Xiaoxiao red, Riley green, Amara teal and Elsie blue. Pink is available for custom figures and hash fallbacks. The two colour stops form the header gradient; the base fill also colours user messages, primary actions, selected tabs and selection highlights.

### Neutral

Ink and muted text sit on a pale character-tinted background with white input and companion-bubble surfaces. Borders also borrow the character colour. Dark mode replaces these with tinted navy surfaces, pale ink and muted lavender text. Error red remains semantic across characters. White labels remain on character-filled controls in both schemes.

### Named Rules

**The Page and Character Colour Rule.** Prefer a usable host-page theme token, then a matching `theme-color` meta value, then visible filled controls. Coloured page backgrounds and styled links are secondary signals. Map the hue to one of the seven existing contrast-tested gradient families; ignore neutral, nearly transparent and default browser-link colours. Sample on opening, host theme changes and resize, with bounded work and no scroll-driven changes. If the page has no usable accent, use the bundled character mapping; custom rig portraits derive colour from iris, hair, then ribbon, falling back to the figure id hash (Profile id before an object portrait resolves). A late portrait never overrides a detected page colour. Keep the header, user bubbles and controls in the selected family; the character artwork itself keeps its original palette.

**The Fill and Accent Rule.** Use character colour for filled controls and user bubbles. Use the derived accent for links, focus and sparkles; dark mode takes the character’s light tone for that accent.

## Typography

Local rounded headings use the `title`, `setup-title`, `headline` and `section` stacks. Body, controls and metadata use the system UI stack with Chinese fallbacks. Tabular numerals apply throughout. There is no bundled display font; actual rounded glyph coverage depends on the device.

The ramp runs from the empty greeting (23px / 750) through the character and setup titles (21px / 750), management headings (17px / 650), dialogue and body (14px), interface prose (13px), labels and actions (12px), bylines and record metadata (11px), to status and composer footnotes (10px). Dialogue leading is 1.75; general body leading is 1.6. Management subheadings use 14px / 650 / 1.4. The mobile character name drops to 19px.

### Named Rules

**The Local Font Rule.** Use only the implemented local font stacks. Rounded headings are a platform-constrained fallback, not a portable display-face recommendation for other surfaces.

**The Mobile Sixteen Rule.** At host viewport widths of 480px and below, text inputs and the composer use 16px text; icon and tab targets grow to at least 44px.

## Layout

The fixed bottom-right frame is at most 390 × 610px: width `min(390px, 100vw - 32px)` and height `min(610px, 100dvh - 40px)`, with 20px safe-area-aware offsets. At 480px and below, width becomes viewport minus 24px, the inset becomes 12px, and height is capped by viewport minus 24px.

A single column holds the header, notices, scrolling content, actions and composer. Header padding is 22px 16px; chat padding is 22px 18px 4px, with 20px between messages. Companion messages reserve 38px for the avatar; user messages begin 42px from the left and align right. Setup uses 22px horizontal padding and management 20px, reducing to 18px on mobile. Fields have 16px gaps; compact controls use 6–10px gaps. Settings tabs scroll horizontally.

## Elevation & Depth

The floating frame casts the sole structural shadow: `0 18px 54px rgb(30 24 65 / .24), 0 4px 12px rgb(30 24 65 / .1)`. Internal depth comes from character-tinted surfaces, bright bubbles, borders and the portrait’s white ring. The header uses a 120-degree gradient, white screentone dots on a 7px grid, and two translucent stripe edges rotated 32 degrees.

## Shapes

The frame is rounded at 22px, fields at 10px, primary actions at 24px and the composer at 26px. Secondary controls and status pills use 20px; settings tabs use 22px. Companion bubble corners are `4px 17px 17px`, with the small upper-left corner suggesting a tail. User bubbles mirror that cue with `17px 4px 17px 17px`. Portraits and icon controls are circular. Four-point sparkles use clipped CSS polygons or inline SVG, not text glyphs.

## Components

### Character Header and Portraits

A 60px circular rig portrait with a 3px white ring sits beside the name and model-status pill; mobile uses 48px. The empty state has a 112px calm portrait stamp and sparkles, while companion bubbles use 29px stamps. Only the header portrait is live. Non-rig, unavailable or unresolved portraits use the inline SVG sparkle fallback.

The portrait switches between calm, thinking and talking from runtime state. Its 170ms tick drives blinking and mouth frames only while live, visible and motion is allowed. Reduced motion retains a static mood. Popup entry is a 0.24s rise from 8px with opacity 0.7 to 1, gated by `prefers-reduced-motion: no-preference`.

### Dialogue

Companion bubbles contain markdown on the input surface, with an avatar and muted byline. User bubbles contain plain text in white on the character fill. Both use 12px 15px padding. Action messages are smaller unboxed text with an inline SVG icon beneath the conversation.

### Buttons and Status

Primary actions span the available width, with a 44px minimum height and white 650-weight text. Hover mixes the character fill 85% with dark navy. Secondary actions are bordered pills, at least 36px tall, with accent text and a soft hover fill. Tertiary actions are underlined accent text; destructive actions use error red. General disabled buttons use 50% opacity. Header icon buttons use translucent black circular fills; model status is a compact translucent black pill.

### Inputs and Composer

Fields have labels above, a 1px firm border, input-surface fill and accent caret. Hover and focus strengthen the border to accent. General keyboard focus is a 2px accent outline with 3px offset; header controls use white. The composer encloses an auto-growing 40–126px textarea and a round 40px send control, enlarged on mobile. Focus-within adds a 1px accent outline. While streaming, send becomes stop; disabled send uses soft fill and muted icon at full opacity.

### Settings and Records

Active tabs are character-filled pills with white text; inactive tabs use muted text and a soft hover background. Memory and history records are separated by thin borders. Memories receive a small four-point accent sparkle with 24px left padding. Metadata, expandable source quotes and edit/delete actions stay compact. Error notices use an 8% red tint over the input surface; storage notices use the soft character tint.

## Do's and Don'ts

### Do:

- Do carry character identity through portraits, gradient stops, bubble fills and active controls.
- Do keep rig portraits decorative and retain textual names, model status and accessible control labels.
- Do retain visible focus outlines and device-driven light, dark and reduced-motion behaviour.
- Do use four-point CSS or SVG sparkles for the empty portrait surround, memory markers and decorative fallback.

### Don't:

- Don't hash bundled characters to arbitrary colours; keep their hand-mapped image colours.
- Don't load external fonts, portrait images or icon fonts into the embedded popup.
- Don't replace the character’s face with invented raster artwork when her rig portrait is available.
