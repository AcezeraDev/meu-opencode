---
name: OpenCode Personal
description: Colored spaces for a personal AI coding agent; the app takes on the tone of the project you are in.
colors:
  space-purple: "#9b7bff"
  space-blue: "#5b8cff"
  space-cyan: "#2fc4de"
  space-green: "#34cc88"
  space-yellow: "#f0bd45"
  space-orange: "#ff8a4c"
  space-red: "#ff5d6c"
  space-pink: "#ff66b8"
  space-gray: "#9aa3b2"
  space-on: "#0b0b10"
  ground-deep: "#07080b"
  panel-base: "#111217"
  layer-01: "#17181e"
  layer-02: "#1d1e26"
  layer-03: "#25262f"
  layer-04: "#2e2f3a"
  readout: "#eef0f6"
  user-mark: "#c7cede"
  error: "#ff5a4e"
  warn: "#f5b33c"
typography:
  ui:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 440
    lineHeight: 1.5
  title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    letterSpacing: "-0.012em"
  readout:
    fontFamily: "var(--font-family-mono)"
    fontSize: "12px"
    fontWeight: 400
    fontFeature: "tnum"
  label:
    fontFamily: "var(--font-family-mono)"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: "12px"
    letterSpacing: "0.06em"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  row: "9px"
  project-row: "11px"
  lg: "12px"
  panel: "14px"
  xl: "16px"
  card: "18px"
  hero: "20px"
  full: "999px"
spacing:
  chip-gap: "6px"
  row: "8px"
  inset: "10px"
  group: "12px"
  nav-pad: "14px"
components:
  titlebar-tab:
    backgroundColor: "{colors.ground-deep}"
    textColor: "{colors.user-mark}"
    rounded: "{rounded.row}"
  titlebar-tab-active:
    backgroundColor: "{colors.layer-01}"
    textColor: "{colors.readout}"
    rounded: "{rounded.row}"
  session-card:
    backgroundColor: "{colors.panel-base}"
    textColor: "{colors.readout}"
    rounded: "{rounded.panel}"
  composer:
    backgroundColor: "{colors.layer-01}"
    textColor: "{colors.readout}"
    rounded: "{rounded.card}"
  send-button:
    backgroundColor: "{colors.space-purple}"
    textColor: "{colors.space-on}"
    rounded: "{rounded.full}"
  home-project-row:
    backgroundColor: "{colors.layer-01}"
    textColor: "{colors.readout}"
    rounded: "{rounded.project-row}"
    height: "34px"
  settings-search:
    backgroundColor: "{colors.panel-base}"
    textColor: "{colors.readout}"
    rounded: "{rounded.md}"
    height: "34px"
    padding: "0 10px"
  settings-nav-item:
    textColor: "{colors.user-mark}"
    rounded: "{rounded.row}"
    height: "32px"
  settings-list:
    backgroundColor: "{colors.layer-01}"
    textColor: "{colors.readout}"
    rounded: "{rounded.panel}"
  chip:
    backgroundColor: "{colors.layer-02}"
    textColor: "{colors.readout}"
    rounded: "{rounded.full}"
    height: "24px"
    padding: "0 10px"
---

# Design System: OpenCode Personal

## Overview

**Creative North Star: "Colored Spaces"**

Every project is a space with a color of its own, and the app takes on the tone of the space you are in. The ground and every panel lean toward that hue; the color itself lands only on what is yours and active: the open tab, the selected project or settings page, focus, and the send button. You know where you are by color alone. Home, which belongs to no project, is the violet space.

The world is built from one variable. `html[data-space]` (set by the tab in use through `enterSpace`) picks `--space` from nine hues, and every neutral, border, wash and accent derives from it with `color-mix`, so a new space is one line. Surfaces are rounded cards (14 to 20px) lifted off a near-black ground with soft shadows that have a real offset. The app stays open all day, so it is calm at rest: backgrounds never move, Lite mode (on by default) stops continuous animation, and the optional RGB cycle for live work exists only when the user turns it on and Lite mode is off.

It refuses the grey chat app with one static blue accent. Tokens live in `packages/ui/src/v2/styles/scope.css`; the shell's use of them lives in `packages/app/src/spaces.css`.

**Key Characteristics:**
- Nine space hues; one of them is the app's accent at any moment, chosen by the project in use.
- Near-black neutrals tinted 6 to 10% toward the space hue; no pure grey surfaces.
- The space color marks only what is yours and active; everything else stays in tinted neutrals.
- Rounded cards with soft offset shadows and a hairline in the space tone.
- A quiet wash of the space color at the top of the session card and the composer, painted once.
- Errors and warnings keep fixed colors in every space.

## Colors

A multi-accent system where exactly one accent is live at a time: the space you are in.

### Primary
- **The Space** (`--space`): the active project's hue, one of the nine below. It fills the send button, the focus ring, the active tab tint, the selected project row and settings page, text selection, caret, scrollbars and native controls. Derived tones: **Space Ink** (`--space-ink`, space mixed 82% toward white in dark, 72% toward ink in light) for accent text and icons; **Space Soft** (16%), **Space Line** (42%) and **Space Wash** (28% dark, 10% light) as translucent layers; **On Space** (`space-on`) for text on a space fill.
- **Violet Space** (`space-purple`): the default and home space.
- **Blue, Cyan, Green, Yellow, Orange, Red, Pink Spaces** (`space-blue` … `space-pink`): the eight hues a project can own. Tuned to read on the dark ground and as a fill.
- **Slate Space** (`space-gray`): only for a project someone explicitly chose grey for; never auto-assigned.

A project's color resolves as: explicit pick in project settings, else the color the layout auto-assigned, else a stable hash of its folder over the eight chromatic spaces. Every view of a project shows the same color.

### Tertiary
- **Error** (`error`, light scheme `#d92d20`) and **Warn** (`warn`, light scheme `#b7791f`): fixed state colors, identical in every space, never cycled.

### Neutral
- **Deep Ground** (`ground-deep`, mixed 7% toward the space): the window behind every card.
- **Panel Base** (`panel-base`, 6%): session card and inputs.
- **Layers 01 to 04** (`layer-01` … `layer-04`, 7 to 10%): composer, lists, nav, raised controls, one step lighter each.
- **Borders** muted / base / strong: white at 5 / 8 / 15% mixed 12 / 16 / 22% toward the space.
- **Readout** (`readout`): measured values in mono. **User Mark** (`user-mark`): prompt markers and quiet text.

The hex values above are the neutral bases before the space tint; the built value is always `color-mix(in oklab, var(--space) N%, base)`. The light scheme mirrors the same structure on a near-white ground (`#ffffff` to `#d4d8e1` bases).

### Named Rules
**The Yours-and-Active Rule.** The space color marks only what is yours and active: the active tab, focus, the send button, the selected project, the selected settings page. Everything else, including hovers, stays in space-tinted neutrals (hover tints stay at 9 to 12%).

**The One Space Rule.** The app wears one space at a time. The only other hues on screen are each tab's and project row's own color (`--own-space`), shown at a faint 10% tint when inactive and filled at 22 to 24% when selected.

**The Fixed State Rule.** Errors and warnings never take the space color and never cycle.

## Typography

**UI Font:** Inter Variable (with ui-sans-serif, system-ui)
**Readout/Label Font:** the project monospace (`--font-family-mono`), tabular numerals

**Character:** A dense, quiet sans at 13px for everything you read, with a mono voice reserved for numbers that are measured.

### Hierarchy
- **Title** (600, 14px, -0.012em): session title on the session card, settings page titles.
- **UI** (440, 13px, 1.5): messages, rows, settings, inputs. Section index items drop to 12.5px, chips to 12px.
- **Readout** (400, 12px mono, tabular): measured values such as today's spend, tokens, time. Utility class `.scope-readout`, with unused leading zeros in `.scope-readout-ghost`.
- **Label** (500, 10px mono, uppercase, 0.06em): the name of a measurement, set beside its readout. Utility class `.scope-label`.

### Named Rules
**The Label-Beside Rule.** A mono label sits on the same line as its readout (`HOJE R$ 0,00`), never as a small heading above a title or section.

## Layout

A titlebar strip of tab pills across the top; below it, the session card and the review/side panels sit side by side on the deep ground with a few pixels of gap, each a separate rounded card. The composer floats at the bottom of the session card as a card of its own. Home centers a hero composer with example chips, then lists projects (a left column of 34px rows) beside their sessions (a search field and session rows). Settings is a centered dialog: a search-first left nav (search, "also in" page chips, grouped pages, General's section index on a space-tinted rail) and a content column of rounded lists.

Rhythm is tight: 6px chip gaps, 8 to 10px row insets, 12 to 14px panel padding. Narrow titlebar tabs collapse to their avatar (container query at 64px) and show close only on hover.

## Elevation & Depth

A hybrid of tonal layering and soft lifted shadows. Surfaces step up through Layers 01 to 04; cards add shadows with a real vertical offset plus a 1px ring in the space-tinted border. There is no backdrop blur and no texture. Selected pills and rows cast a colored shadow in their own space; the send button carries a small glow in the space color.

### Shadow Vocabulary
- **Raised** (`--v2-elevation-raised`, dark: `0 1px 0 rgb(255 255 255 / 0.035) inset, 0 2px 4px rgb(0 0 0 / 0.3), 0 10px 28px -10px rgb(0 0 0 / 0.6), 0 0 0 1px border-muted`): the session card.
- **Floating** (`--v2-elevation-floating`, dark: `... 0 6px 14px rgb(0 0 0 / 0.35), 0 24px 56px -16px rgb(0 0 0 / 0.7), 0 0 0 1px border-base`): composer and home hero composer.
- **Overlay** (`--v2-elevation-overlay`, dark: `... 0 12px 28px rgb(0 0 0 / 0.4), 0 40px 80px -20px rgb(0 0 0 / 0.75), 0 0 0 1px border-base`): dialogs, settings.
- **Own-space lift** (`0 6px 16px -8px` / `0 8px 20px -12px` of the element's own space at 70 to 80%): the active tab and the selected project row.

### Named Rules
**The Still Ground Rule.** Backgrounds never animate. The top wash on the session card and the workspace glow (two radial gradients of the space at 14% and 8%) are painted once.

## Shapes

Soft, consistent rounding that grows with the surface: 7 to 9px for pills, nav items and index rows; 10 to 12px for search fields, project and session rows; 14px for panels and settings lists; 18px for the composer and settings dialog; 20px for the home hero composer; fully round for chips and example prompts. Base scale from Tailwind: 4 / 6 / 8 / 12 / 16 / 20px. Project avatars are rounded squares carrying the project's initial on its space color, not dots.

## Components

### Titlebar tabs
Soft pills (9px). Inactive tabs keep a faint 10% tint of their own space over the deep ground; the open tab fills with 24% of its space over Layer 01, a 42% inset ring and an own-space lift, with base text. The pill is the only "you are here" marker; no underline. Squeezed tabs keep the avatar.

### Session card
A rounded panel (14px) on Panel Base with the Raised shadow and a space wash at its top (28% at 0, 5% at 180px, clear by 420px). The sticky title takes the wash's tone so it never cuts the wash with a hard line.

### Composer
A floating card (18px) on Layer 01 with an 8% space gradient at its top, the Floating shadow and a 22% space inset ring. On focus the ring rises to 58% and a 4px outer ring at 14% appears. The home hero composer is the same at 20px with a 10% gradient.

### Buttons
- **Send:** solid space fill with dark text (`#04070a`), a 70% ring and a small 18px glow; presses to 0.94 scale. While stopping it drops to a 16% space tint with space-colored icon. Disabled it is a neutral grey disc.
- **Home send:** space fill, On Space text, soft own-color shadow.

### Chips
Fully round, 24px, 12px text. Example prompts on home turn 16% space on hover. Settings "also in" chips sit at 18% space, 30% on hover.

### Inputs / Fields
Settings search: 34px, 10px radius, Panel Base with a base-border inset. Focus: 60% space inset plus a 3px ring at 18%. Placeholder in faint text; the search is accent-insensitive and hides rows it leaves out.

### Navigation
Settings nav items are 32px, 9px radius. Hover 10% space over Layer 02; the selected page 22% space with a 38% inset ring, base text and a Space Ink icon. General's section index sits under it on a 1px rail at 30% space, 26px rows, 12.5px muted text.

### Home project rows
34px rows, 11px radius, 10px gap between avatar and name. Hover 12% of their own space; selected fills 22% own space over Layer 01 with a 40% inset ring and an own-space lift. Picking one tints the whole app. Session rows are 12px radius with a 9% space hover.

### Settings lists
Rounded groups (14px) on Layer 01 with a muted-border inset and a soft drop (`0 8px 20px -14px rgb(0 0 0 / 0.5)`).

### Live work
What is live wears `--chroma`: the space color by default, or a cycling OKLCH hue (6s / 14s / 28s per turn) when the user enables the RGB cycle and Lite mode is off. Reduced motion and Lite mode keep it on the space color.

## Do's and Don'ts

### Do:
- **Do** derive every new color from `--space` with `color-mix`; a new surface should change tone when the space changes.
- **Do** give the space color only to what is yours and active: active tab, focus, send, selected project or page.
- **Do** show a project's own color through `--own-space` on its tab and row, faint when inactive, filled when selected.
- **Do** lift cards with the Raised / Floating / Overlay shadows and step surfaces through Layers 01 to 04.
- **Do** keep errors at `#ff5a4e` and warnings at `#f5b33c` (dark) in every space.
- **Do** respect Lite mode (on by default): continuous animations stop, one-shot ones finish in 1ms, spinners stay.
- **Do** set mono labels beside their readouts, in fixed digit slots.

### Don't:
- **Don't** animate backgrounds, washes or the workspace glow.
- **Don't** run the RGB cycle unless the user turned it on and Lite mode is off.
- **Don't** paint the space color on hovers, idle rows or decoration beyond a 12% tint.
- **Don't** add texture, grids or backdrop blur to panels.
- **Don't** replace project avatars with dots or glyphs; they are rounded squares with the project's initial.
- **Don't** use a mono uppercase label as a kicker above a heading.
