---
version: 1
slug: "src-pages-session-tsx"
primary_target: "src/pages/session.tsx"
related_targets: ["src/pages/home.tsx","src/components/titlebar.tsx","src/components/settings-v2/dialog-settings-v2.tsx"]
---

# App shell, session, home and settings — OpenCode Personal

Scope: the whole app in the new layout: titlebar with session tabs, home (projects and sessions), the session page (timeline, composer, side panels) and the settings dialog. Visitor mode: Operate.

Audience and job: the owner, all day in the dark scheme, in long sessions on one project (sites/apps, videos). Needs to find and switch projects and sessions fast, see what the agent is doing now, and find a setting without hunting.

Constraints: every feature, screen and shortcut stays; en/br strings; upstream merges (restyle through tokens and CSS, keep component structure); Lite mode (default on) stops continuous animation; reduce-motion keeps state and color, drops movement; no large blurred or animated backgrounds.

Pain points named by the owner (2026-09-24): navigation (finding and switching projects/sessions) and Settings (too many options, hard to find).

## Direction contract

THESIS: Each project is a colored space; the app takes on the tone of the space you are in. Refuses the grey chat app with one static blue accent.
OWN-WORLD: near-black ground tinted by the space hue; rounded cards (14–18px) with soft offset shadows; the space color on the active tab, focus, send button and a quiet top wash; project avatars as color dots; live work as a gradient sweep in the space hue.
STORY: The owner knows where they are by color alone, jumps between spaces from home or tabs, and finds any setting from a search-first index.
FIRST VIEWPORT: titlebar pills tinted by each tab's space; session card with a soft space-colored wash at its top; composer card floating at bottom with the send button in the space color; home lists spaces as colored cards beside their sessions.
FORM: Arc-style colored spaces, candidate 1 of 7 (the pick), seed cb192234.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
