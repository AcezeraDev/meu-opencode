---
name: Lynx Code
description: A personal AI coding agent that always wears its logo's colors — white, cyan, indigo and a dark blue.
colors:
  lynx-cyan: "#ff6b5b"
  lynx-indigo: "#e5484d"
  lynx-navy: "#0b1226"
  lynx-fill: "#d13a3f light / #e5484d dark"
  space-cyan: "#ff6b5b"
  space-green: "#2dd4bf"
  space-yellow: "#ffa79b"
  space-blue: "#ff8a72"
  space-orange: "#ff9a8a"
  space-purple: "#ef7a7e"
  space-red: "#e5484d"
  space-pink: "#f6a9ab"
  space-gray: "#94a3b8"
  space-on: "#0b1226"
  ground-deep: "#070b19"
  panel-base: "#0b1226"
  layer-01: "#101831"
  layer-02: "#152040"
  layer-03: "#1b284d"
  layer-04: "#22305c"
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

**Creative North Star: "Lynx Code"**

The app always wears its logo: a command prompt (>_) lit inside a cyan-to-indigo circle on dark blue (`branding/lynx-code.svg`). Its colors are permanent: the dark blue ground, white text, the logo's cyan as the one accent, and its indigo for filled controls. They do not change with the project in use.

The world is still built on the colored spaces structure: tokens in `packages/ui/src/v2/styles/scope.css`, the shell's use of them in `packages/app/src/spaces.css`, and the default theme (`oc-2`, shown as "Lynx Code") carrying the same palette for text, syntax and avatars. Surfaces are rounded cards (14 to 20px) lifted off the dark blue ground with soft offset shadows. The app stays open all day, so it is calm at rest: backgrounds never move, Lite mode (on by default) stops continuous animation, and the optional live-color cycle only sweeps between the logo's cyan and indigo.

**Key Characteristics:**
- One accent, always: the logo cyan (`--space`). Filled controls use the indigo (`--lynx-fill`), which white text reads on.
- Dark blue neutrals (`#070b19` to `#22305c`) in the dark scheme; white and pale blue-grey (`#ffffff` to `#d3dbec`) in the light one.
- Each project keeps a shade between cyan and indigo for its own tab and avatar, so projects still tell apart without leaving the palette.
- A quiet cyan wash at the top of the session card and the composer, painted once.
- Errors and warnings keep fixed red and amber.

## Colors

### Primary
- **Lynx Cyan** (`--space`, `--lynx-coral`): the accent everywhere — focus ring, the active tab tint, the selected project row and settings page, text selection, caret, scrollbars, native controls, the send button and the agent's cursor in the browser. Derived tones: **Space Ink** (`--space-ink`, cyan mixed 82% toward white in dark; the indigo `#d13a3f` in light, where cyan would not read on white) for accent text and icons; **Space Soft** (16%), **Space Line** (42%) and **Space Wash** (28% dark, 10% light); **On Space** (`space-on`, the dark blue) for text on a cyan fill.
- **Lynx Indigo** (`--lynx-fill`, `--v2-background-bg-accent`): checkboxes, switches, radios, badges and other filled controls with white on them.
- **Project shades** (`space-cyan` … `space-gray`): a project's own color for its tab and avatar (`--own-space`). The names are the colors a project can pick, kept so saved choices still resolve; each now maps to a shade from cyan to indigo.

A project's shade resolves as: explicit pick in project settings, else the color the layout auto-assigned, else a stable hash of its folder.

### Session Tones
Each session wears a tone of its own inside its project's shade: the same hue turned 15 or 30 degrees either way (kept small so it stays between cyan and indigo), or softened (`[data-tone]` 0 to 5 in `spaces.css`, `context/session-tone.ts`). It replaces `--own-space` on the session's tab and its home row.

### Tertiary
- **Error** (`error`, light scheme `#d92d20`) and **Warn** (`warn`, light scheme `#b7791f`): fixed state colors, identical in every space, never cycled.

### Neutral
- **Deep Ground** (`ground-deep`, `#070b19`): the window behind every card.
- **Panel Base** (`panel-base`, the logo dark blue `#0b1226`): session card and inputs.
- **Layers 01 to 04** (`layer-01` … `layer-04`): composer, lists, nav, raised controls, one step lighter each.
- **Borders** muted / base / strong: white at 5 / 8 / 15% mixed 12 / 16 / 22% toward the cyan.
- **Readout** (`readout`): measured values in mono. **User Mark** (`user-mark`): prompt markers and quiet text.

The light scheme mirrors the same structure on white (`#ffffff` panels over a `#eef2fa` ground, layers down to `#d3dbec`). The default theme ramps (`v2-grey-*`) lean toward the dark blue in both schemes.

### Named Rules
**The Yours-and-Active Rule.** The space color marks only what is yours and active: the active tab, focus, the send button, the selected project, the selected settings page. Everything else, including hovers, stays in space-tinted neutrals (hover tints stay at 9 to 12%).

**The One Accent Rule.** The app wears the logo cyan in every project. The only other hues on screen are each tab's and project row's own color (`--own-space`), shown at a faint 10% tint when inactive and filled at 22 to 24% when selected.

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

## Motion

Every movement tells the owner something changed, arrived or finished, and each one runs once, set off by that event. Three times (`--motion-quick` 140ms, `--motion-base` 240ms, `--motion-move` 420ms) and three curves (`--motion-ease-out`, the approved overshoot `--motion-ease-spring`, and `--motion-ease-inout` for crossing a whole space) live in `ui/src/v2/styles/scope.css`; the JavaScript movements read the same values from `app/src/utils/motion.ts`.

- **Space crossing:** a space change caused by a click spreads the new color in a circle from the click (a view transition over the whole window). Keyboard and restored routes change at once.
- **Sliding pill:** the mode switcher and the Settings pages have one selection marker that glides to the new option, stretching over both on the way outside Lite mode.
- **Prompt rising:** a sent prompt rises from the composer into its place in the chat.
- **Writing front:** the newest words of a live answer start in Space Ink and cool to the text color in three steps (CSS highlights, so the markdown renderer is untouched).
- **Beats:** a marker that lands on the conversation overview while it is open grows with a spring and opens a ring once; new steps in the Trail mode slide in and their node jumps when they finish.
- **Background tab:** a working tab with an estimate draws an arc around its avatar that fills with the share of the estimate spent; when the work ends the avatar jumps once and the unread dot pops in.
- **Numbers:** today's spend and the context percentage roll digit by digit (`Odometer`); an edit in the live answer counts its `+N -N` up; the context ring fills with the spring and, after a compaction, squeezes while the freed part fades as a ghost arc.
- **Arrivals in the composer:** a long paste shows its first lines for a moment and folds into its `texto-colado.md` card; a dropped file falls from where it was let go and lands with a small squash (`session-ui/.../prompt-input/arrival.ts`).
- **Queue:** a prompt sent while the agent works flies into the follow-up queue, which bumps; when it is sent it rises from the queue into the chat.
- **Model board:** the model name turns over like a station board when it changes (`FlipText`).
- **Asking:** a permission or question card rises into the composer's place; a background tab whose session asks knocks twice on its avatar.
- **Brake:** stopping the agent slows the session's endless movements to a halt, and the "interrupted" mark drops in like a stamp.
- **Cost:** a finished response's cost flies in an arc to today's spend, which rolls to the new total.
- **Rewind and fork:** undo folds the turn away from its last row up to its prompt, which drops back into the composer; a fork's message flies into the tab strip, where the new tab pops open.
- **Palette:** rows that survive a filter slide to their new place (`flipList`).
- **Page on its way:** a line in the space color runs under the browser pane's address while a page loads, and the old page dims until the new one lands.
- **Agent cursor:** the cursor drawn in the browsed page wears the project's space (`opencode/src/browser/accent.ts`), carries an "IA" tag, and names its target on a tab above the outline.

### Named Rules
**The Lite-Kept Rule.** A one-shot movement that is short, set off by an event and moves only `transform`, `opacity` or color may carry `data-motion="l"`: Lite mode then keeps it (shortened: `--motion-move` drops to 240ms and the spring to the plain ease-out) instead of cutting it to 1ms. Anything continuous never carries it. Reduced motion stops both.

## Do's and Don'ts

### Do:
- **Do** derive every new color from `--space` with `color-mix`; a new surface should change tone when the space changes.
- **Do** give the space color only to what is yours and active: active tab, focus, send, selected project or page.
- **Do** show a project's own color through `--own-space` on its tab and row, faint when inactive, filled when selected.
- **Do** lift cards with the Raised / Floating / Overlay shadows and step surfaces through Layers 01 to 04.
- **Do** keep errors at `#ff5a4e` and warnings at `#f5b33c` (dark) in every space.
- **Do** respect Lite mode (on by default): continuous animations stop, one-shot ones finish in 1ms unless they carry `data-motion="l"`, spinners stay.
- **Do** set mono labels beside their readouts, in fixed digit slots.

### Don't:
- **Don't** animate backgrounds, washes or the workspace glow.
- **Don't** run the RGB cycle unless the user turned it on and Lite mode is off.
- **Don't** paint the space color on hovers, idle rows or decoration beyond a 12% tint.
- **Don't** add texture, grids or backdrop blur to panels.
- **Don't** replace project avatars with dots or glyphs; they are rounded squares with the project's initial.
- **Don't** use a mono uppercase label as a kicker above a heading.
