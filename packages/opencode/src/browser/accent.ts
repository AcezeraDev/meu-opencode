/**
 * The color the agent's cursor wears in the page: the project's space, the
 * same one the app is tinted with while that project is open. A color picked
 * in the project's settings wins; otherwise a stable hash of its folder picks
 * one of the eight colors, exactly as the app does
 * (`app/src/context/project-space.ts`), so the cursor in the browser matches
 * the tab it belongs to.
 *
 * Returned as "r, g, b" so the overlay can mix its own alphas.
 */

const SPACES: Record<string, string> = {
  purple: "155, 123, 255",
  blue: "91, 140, 255",
  cyan: "47, 196, 222",
  green: "52, 204, 136",
  yellow: "240, 189, 69",
  orange: "255, 138, 76",
  red: "255, 93, 108",
  pink: "255, 102, 184",
  gray: "154, 163, 178",
}
const HASHED = ["purple", "blue", "cyan", "green", "yellow", "orange", "red", "pink"]
const ALIASES: Record<string, string> = { mint: "cyan", lime: "green" }

export function of(project: { icon?: { color?: string }; worktree?: string } | undefined) {
  const picked = project?.icon?.color
  const named = picked ? (ALIASES[picked] ?? picked) : undefined
  if (named && SPACES[named]) return SPACES[named]
  if (!project?.worktree || project.worktree === "/") return SPACES.purple
  const folder = project.worktree.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  const hash = [...folder].reduce((sum, char) => (Math.imul(sum, 31) + char.charCodeAt(0)) | 0, 7)
  return SPACES[HASHED[Math.abs(hash) % HASHED.length]]
}

export * as BrowserAccent from "./accent"
