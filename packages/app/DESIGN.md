---
name: OpenCode Personal
description: Bench-oscilloscope instrument world for a personal AI coding agent.
colors:
  screen: "#0b0f12"
  canvas-deep: "#050709"
  bezel-01: "#11161a"
  bezel-02: "#171e23"
  bezel-03: "#1f272d"
  bezel-04: "#283238"
  readout: "#e6edf3"
  channel-edit: "#3fd0e0"
  channel-user: "#c9d3dc"
  channel-warn: "#f5b33c"
  channel-error: "#ff5a4e"
  trace: "oklch(0.8 0.16 190)"
typography:
  ui:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 440
    lineHeight: 1.5
  title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "21px"
    letterSpacing: "-0.011em"
  readout:
    fontFamily: "var(--font-family-mono)"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  label:
    fontFamily: "var(--font-family-mono)"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: "12px"
    letterSpacing: "0.06em"
rounded:
  control: "6px"
  action: "7px"
  strip: "10px"
  panel: "12px"
  sheet: "16px"
  full: "999px"
spacing:
  cell: "6px"
  row: "8px"
  group: "14px"
  section: "24px"
components:
  measurement-strip:
    backgroundColor: "{colors.bezel-01}"
    textColor: "{colors.readout}"
    rounded: "{rounded.strip}"
    height: "34px"
    padding: "0 12px 0 8px"
  instrument-panel:
    backgroundColor: "{colors.bezel-01}"
    textColor: "{colors.readout}"
    rounded: "{rounded.panel}"
    padding: "12px"
  panel-action:
    backgroundColor: "{colors.bezel-03}"
    textColor: "{colors.readout}"
    rounded: "{rounded.action}"
    height: "28px"
  panel-action-hover:
    backgroundColor: "{colors.bezel-04}"
---

# Design System: OpenCode Personal

## Overview

**Creative North Star: "The Bench Oscilloscope"**

Every AI response is a live signal measured on an instrument screen. The chat sits on a phosphor-black screen under a faint, static graticule; the chrome around it is opaque instrument bezel. While the agent works, the screen comes alive: an RGB trace runs around the chat's edge, a measurement strip reads the signal above the composer, and each finished response leaves its measurements behind as a footer.

The app stays open all day, so the world is calm at rest and expressive only while something is happening. Color and motion always report a state; nothing moves just to decorate.

**Key Characteristics:**
- Phosphor-black screen with a graticule that never moves.
- One RGB trace color that cycles continuously, reserved for what is live or active.
- Fixed channel colors for everything that is not live (edits, prompts, warnings, errors).
- Monospace readouts in fixed slots, with unused leading zeros drawn as ghosts.
- Live readouts dissolve into a per-response summary when a turn ends.

## Colors

Dark scheme is primary; the light scheme ("print mode") inverts to a near-white screen with the same rules. Tokens live in `packages/ui/src/v2/styles/scope.css`.

### Primary
- **Trace** (`--chroma`, `oklch(L C var(--chroma-hue))`): the live signal. Its hue cycles through the full wheel (6s, 14s or 28s per turn, from Settings). The token value above is its resting hue when RGB is off or motion is reduced.

### Secondary
- **Edit channel** (`#3fd0e0`): file edits in the overview bar, focus outlines, the daily spend meter.

### Tertiary
- **Warn channel** (`#f5b33c`) and **Error channel** (`#ff5a4e`): context above 70% / 90%, spend near / over the daily limit, errors. They never cycle.

### Neutral
- **Screen** (`#0b0f12`) under the graticule, **Canvas deep** (`#050709`) behind panels, **Bezels 01–04** (`#11161a` → `#283238`) for raised instrument surfaces, **Readout** (`#e6edf3`) for measured values, **User channel** (`#c9d3dc`) for prompt markers.

### Named Rules
**The Trace Law.** Only what is live or active wears the RGB trace: the chat edge while responding, the send/stop button, the active tab, the CH1 chip, the live overview marker, the primary "compact now" action. Everything else uses a fixed channel color.

**The Still Screen Rule.** Backgrounds never animate. A moving layer behind panels would make every blur and repaint recompute each frame in an app that stays open all day.

## Typography

**UI:** Inter Variable (13px/440 for body, 15px/600 for titles).
**Readouts and labels:** the project monospace (`--font-family-mono`), tabular numerals.

### Hierarchy
- **Title** (600, 15px, 21px): session title in context views.
- **UI** (440, 13px): messages, rows, settings.
- **Readout** (400, 12px mono, tabular): measured values: time, tokens, speed, cost, percentages.
- **Label** (500, 10px mono, uppercase, 0.06em): the name of the measurement next to its readout.

### Named Rules
**The Fixed Slot Rule.** Numbers that change while you watch sit in fixed digit slots (`00:42`, `038 tok/s`, `014`), with the unused leading zeros drawn in the ghost color, so values never jitter.

**The Label-Beside Rule.** A measurement label sits beside its value on the same line, never as a small heading above a big number.

## Layout

The chat column is centered on the screen; instruments dock to its edges instead of floating over content. The measurement strip docks above the composer; the per-response summary closes each turn; the overview bar runs inside the timeline's 16px right padding and hides below 640px wide. Wide panels place context-tab sections side by side through container queries.

## Elevation & Depth

Instrument surfaces are opaque (no backdrop blur). Depth comes from bezel steps (01 → 04) and soft drop shadows on floating panels (`0 16px 40px rgb(0 0 0 / 0.3)`). The only glow in the world belongs to the trace.

## Shapes

Controls 6px, panel actions 7px, strips 10px, panels 12px, full-screen sheets 16px, meters fully rounded. Tick lines and rules are 1px; dashed rules separate measured summaries from content.

## Components

### Buttons
Send / stop is lit with the trace (solid trace fill with a glow when ready to send; a faint trace tint with trace-colored icon while stopping). Panel actions are bezel-03 fills with a 0.97 press scale; the primary action takes a trace-tinted fill.

### Measurement strip
34px strip above the composer while the agent works: CH1 chip, TIME, RATE with its trace, STEP, STEPS, COST. It sweeps in from the left, holds its last values when the turn ends and dissolves into the response summary.

### Response summary
A dashed-rule footer under each finished turn with DURATION, TOOLS, FILES, OUTPUT, RATE and COST; a fresh one settles in with a trace sweep along its rule.

### Overview bar
The acquisition overview turned vertical: ticks for prompts (user channel), edits (edit channel), errors (error channel), the live head (trace), and a window for what is on screen. Click to jump; hover prompts to read them.

### Context ring and spend readout
The composer ring reads context use (trace, then warn, then error); its panel offers compaction. The titlebar readout shows today's spend across sessions; its panel sets the daily limit. Both panels render in a portal anchored to their control.

### Softkeys
Holding Ctrl for 650ms raises a sheet of every shortcut available, grouped by area; releasing Ctrl or pressing any other key closes it.

## Do's and Don'ts

### Do:
- **Do** give anything live the trace color, and take it away when it stops being live.
- **Do** put changing numbers in fixed slots with ghost zeros.
- **Do** dock instruments to the edges of the content they measure.
- **Do** animate only transform and opacity on small layers, and pause loops when their owner is inactive.
- **Do** keep reduced motion meaningful: stop cycling and movement, keep state colors.

### Don't:
- **Don't** animate backgrounds, the graticule, or anything under large surfaces.
- **Don't** cycle the color of errors, warnings or edits.
- **Don't** set a small label above a big number (hero-metric); put the label beside the value.
- **Don't** reintroduce translucent glass or backdrop blur on panels.
- **Don't** add a trace or glow to static, non-live elements for decoration.
