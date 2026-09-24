import { createStore } from "solid-js/store"
import type { ProjectAvatarVariant } from "@opencode-ai/ui/v2/project-avatar-v2"

/** The colors a project can own as its space; grey is for a project someone chose grey for. */
const SPACE_COLORS = ["purple", "blue", "cyan", "green", "yellow", "orange", "red", "pink"] as const

/**
 * The colors the layout gave projects that had none (see `pickAvailableColor`),
 * by folder. Other project lists (home, tabs) read the server's copy, which
 * only has the color once it is saved there; they look here first so every
 * view of a project shows the same color right away.
 */
const [assignedColors, setAssignedColors] = createStore<Record<string, string>>({})

/** Records a color the layout gave a project, for every other view of it. */
export function rememberAssignedColor(folder: string, color: string) {
  if (assignedColors[folderKey(folder)] !== color) setAssignedColors(folderKey(folder), color)
}

function folderKey(folder: string) {
  // One folder arrives spelled with either slash, in either case, with or
  // without a trailing slash; each spelling is the same project.
  return folder.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
}

/**
 * A project's color. One picked in the project's settings wins; otherwise
 * `seed` (the project's folder) picks one that stays the same every
 * time, so every project has a color of its own and the app can take on the
 * tone of the one in use.
 */
export function getProjectAvatarVariant(key?: string, seed?: string): ProjectAvatarVariant {
  if (key === "mint") return "cyan"
  if (key === "lime") return "green"
  if (
    key === "orange" ||
    key === "yellow" ||
    key === "cyan" ||
    key === "green" ||
    key === "red" ||
    key === "pink" ||
    key === "blue" ||
    key === "purple" ||
    key === "gray"
  )
    return key
  if (!seed) return "gray"
  const folder = folderKey(seed)
  const assigned = assignedColors[folder]
  if (assigned) return getProjectAvatarVariant(assigned)
  const hash = [...folder].reduce((sum, char) => (Math.imul(sum, 31) + char.charCodeAt(0)) | 0, 7)
  return SPACE_COLORS[Math.abs(hash) % SPACE_COLORS.length]!
}

/** The space (color) of a project, or of a folder that is not a known project. */
export function projectSpace(project: { worktree?: string; icon?: { color?: string } } | undefined, directory?: string) {
  return getProjectAvatarVariant(project?.icon?.color, project?.worktree ?? directory)
}

/**
 * Tints the app with a space's color. Without one (home), the app keeps its
 * own default space.
 */
export function enterSpace(space: ProjectAvatarVariant | undefined) {
  if (typeof document === "undefined") return
  if (space) document.documentElement.dataset.space = space
  else delete document.documentElement.dataset.space
}
