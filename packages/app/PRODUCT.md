# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the owner of this checkout, a Brazilian Portuguese speaker on Windows who keeps the desktop app (OpenCode Personal) open all day. Confirmed jobs: programming websites and apps with an AI agent, generating videos and creatives for those sites, and working in long sessions inside a single project.

## Product Purpose

A personal build of OpenCode, the open-source AI coding agent, packaged as a desktop app that rebuilds itself from this checkout. It exists so the owner can shape the agent and its interface around their own workflow. Success means long agent sessions stay legible and controllable, and the app feels like the owner's own tool.

## Positioning

Unlike the official OpenCode app, this build carries the owner's own features (web video generation through NanoGPT, session board and layout modes, an in-app update button that compiles the local code) and the owner's own visual identity.

## Operating Context

- Runs as an Electron app on Windows; the UI is the SolidJS web app in `packages/app`, the server runs on Node inside Electron (no Bun APIs there).
- Kept open for hours, usually in the dark color scheme, next to a browser and editor.
- Sessions are long: many turns, tool calls, file edits, and accumulated context.
- The owner prefers cheap models (NanoGPT, a ChatGPT subscription with usage limits). OpenCode Zen free models do not work in this build (version gate).

## Capabilities and Constraints

- Upstream OpenCode is merged into this checkout regularly; changes should stay contained so merges keep working.
- The interface is translated; the owner reads Portuguese (`br`), English (`en`) is the source locale.
- Large translucent blurred surfaces exist (glass theme); anything that repaints behind them every frame costs GPU time for an app that stays open all day.
- Existing features to preserve: command palette, session tabs, review panel, terminal, file tree, follow-up queue, completion sounds and notifications, message navigation, fork/compact/undo, context tab, web video tool, session board, layout modes, personal update button.

## Brand Commitments

- Pinned by the owner (2026-09-17): the accent color is RGB and continuously cycles through hues. It lives on highlights and becomes a strong glow around the chat while the AI is responding; backgrounds stay calm.
- Pinned by the owner (2026-09-17): the app should feel strongly animated.
- Interface language: Brazilian Portuguese.

## Evidence on Hand

- Real sessions, messages, token usage, and costs from the owner's local OpenCode data.
- No testimonials, customers, or metrics exist; none may be invented.

## Product Principles

1. Motion and color serve the work: every animation also tells the owner something (the agent is working, something changed, where they are).
2. Long sessions must stay navigable and their cost visible.
3. An app open all day must stay smooth; expensive effects run only when they carry meaning.
4. Keep the owner in control of the agent: see what it is doing now, stop it, and understand what it did.

## Accessibility & Inclusion

Respect the system "reduce motion" preference: keep meaning (state, color) and drop movement.
