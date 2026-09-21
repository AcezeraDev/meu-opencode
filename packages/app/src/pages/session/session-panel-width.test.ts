import { describe, expect, test } from "bun:test"
import {
  clampSessionPanelWidth,
  REVIEW_PANE_WIDTH_MIN,
  REVIEW_PANE_WIDTH_MIN_SPLIT,
  resolveSessionDiffStyle,
  SESSION_PANEL_WIDTH_MIN,
  sessionPanelWidthMax,
  sessionSplitDiffAvailable,
} from "./session-panel-width"

describe("sessionSplitDiffAvailable", () => {
  test("waits for enough room for chat and a split review", () => {
    const minimum = SESSION_PANEL_WIDTH_MIN + REVIEW_PANE_WIDTH_MIN_SPLIT
    expect(sessionSplitDiffAvailable({ available: minimum - 1, session: true })).toBeFalse()
    expect(sessionSplitDiffAvailable({ available: minimum, session: true })).toBeTrue()
  })

  test("only reserves the review minimum in review focus", () => {
    expect(sessionSplitDiffAvailable({ available: REVIEW_PANE_WIDTH_MIN_SPLIT - 1, session: false })).toBeFalse()
    expect(sessionSplitDiffAvailable({ available: REVIEW_PANE_WIDTH_MIN_SPLIT, session: false })).toBeTrue()
  })

  test("keeps the stored preference before the workspace is measured", () => {
    expect(sessionSplitDiffAvailable({ available: undefined, session: true })).toBeTrue()
  })
})

describe("resolveSessionDiffStyle", () => {
  test("temporarily presents a unified diff when split would be unreadable", () => {
    expect(resolveSessionDiffStyle({ style: "split", available: 900, session: true })).toBe("unified")
  })

  test("restores split presentation when enough room returns", () => {
    expect(resolveSessionDiffStyle({ style: "split", available: 1300, session: true })).toBe("split")
  })
})

describe("sessionPanelWidthMax", () => {
  test("reserves the unified review pane minimum", () => {
    expect(sessionPanelWidthMax({ available: 1700, split: false })).toBe(1700 - REVIEW_PANE_WIDTH_MIN)
  })

  test("reserves a larger minimum for split diffs", () => {
    expect(sessionPanelWidthMax({ available: 1700, split: true })).toBe(1700 - REVIEW_PANE_WIDTH_MIN_SPLIT)
    expect(REVIEW_PANE_WIDTH_MIN_SPLIT).toBeGreaterThan(REVIEW_PANE_WIDTH_MIN)
  })

  test("lets the chat panel take everything beyond the review pane minimum", () => {
    // Regression: the old cap was 45% of the window, forcing the review pane
    // to at least 55% of the window regardless of content.
    const available = 3440
    expect(sessionPanelWidthMax({ available, split: false })).toBeGreaterThan(available * 0.45)
  })

  test("never drops below the chat panel minimum on small windows", () => {
    expect(sessionPanelWidthMax({ available: 600, split: true })).toBe(SESSION_PANEL_WIDTH_MIN)
    expect(sessionPanelWidthMax({ available: 0, split: false })).toBe(SESSION_PANEL_WIDTH_MIN)
  })
})

describe("clampSessionPanelWidth", () => {
  test("keeps widths already within the limit", () => {
    expect(clampSessionPanelWidth({ width: 800, available: 1700, split: false })).toBe(800)
  })

  test("forces the width down when the window shrinks", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: 1700, split: false })).toBe(1700 - REVIEW_PANE_WIDTH_MIN)
    expect(clampSessionPanelWidth({ width: 1600, available: 1700, split: true })).toBe(
      1700 - REVIEW_PANE_WIDTH_MIN_SPLIT,
    )
  })

  test("holds the chat panel minimum when there is no room for both", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: 700, split: true })).toBe(SESSION_PANEL_WIDTH_MIN)
  })

  test("skips clamping before the layout is measured", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: undefined, split: false })).toBe(1600)
  })
})
