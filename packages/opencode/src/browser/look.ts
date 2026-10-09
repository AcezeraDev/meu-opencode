/**
 * "Look only": the person switched the browser to reading. The agent may open
 * pages, scroll and read them, but every action that could change something on
 * a site (click, type, submit, upload, run page JavaScript) is refused.
 */

/** Browser consent actions that only read: opening a page, scrolling, waiting. */
const READING = new Set(["goto", "new_tab", "open_external", "scroll", "hover", "wait_for", "script", "site_check"])

export const MESSAGE =
  "Modo só olhar está ligado pelo usuário: você pode abrir páginas, rolar e ler, mas não pode clicar, digitar, enviar nem rodar JavaScript na página. Não tente outro caminho para agir. Termine a análise lendo a página e diga ao usuário o que faria."

/** Whether the session (or the session that started it) asked for look only. */
export function active(metadata: Record<string, unknown> | undefined) {
  return metadata?.["browserLook"] === true
}

/** Whether look only refuses this permission request. */
export function blocks(permission: string, action: unknown) {
  if (permission === "browser_evaluate") return true
  if (permission !== "browser") return false
  return typeof action === "string" && !READING.has(action)
}

export * as BrowserLook from "./look"
