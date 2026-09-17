---
version: 1
slug: "src-pages-session-tsx"
primary_target: "src/pages/session.tsx"
related_targets: []
---

# Session surface (chat) — OpenCode Personal

Scope: the session page and the app shell around it (titlebar, composer, timeline, side panel). Visitor mode: Operate.

Audience and job: the owner, in long sessions on one project, programming sites/apps and generating videos; needs to see what the agent is doing now, what it cost, and where they are in the conversation.

Constraints: dark scheme first; app stays open all day (effects that repaint large blurred areas run only while the agent is working); en/br strings; upstream merges; reduce-motion keeps state and color, drops movement.

Chosen features: live response readouts, conversation overview bar, per-response summary, daily spend, held-Ctrl shortcut softkeys, context ring with one-click compact.

## Direction contract

THESIS: Every AI response is a live signal measured on an instrument screen; refuses the default dark chat with one static accent.
OWN-WORLD: phosphor-black canvas under a faint graticule; one RGB trace whose hue cycles continuously; error red never cycles; readouts in mono inside fixed slots with ghost zeros; softkey labels along edges.
STORY: The owner sees at a glance that the agent works, how fast, on what, at what cost; jumps through long sessions by the overview bar; learns shortcuts from softkeys.
FIRST VIEWPORT: chat column over the graticule; while streaming, an RGB trace runs the chat panel edge; a measurement strip docks above the composer; overview bar at the timeline's right edge; context ring on the send button; day spend in the titlebar.
FORM: bench oscilloscope, candidate 5 of 7, seed a6f6a7ab.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
