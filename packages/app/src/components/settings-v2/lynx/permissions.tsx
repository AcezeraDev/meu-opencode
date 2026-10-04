import type { Config } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { showToast } from "@/utils/toast"
import "./lynx-settings.css"

type Action = "allow" | "ask" | "deny"
type Column = "all" | "build" | "plan"

const TOOLS = ["read", "edit", "bash", "webfetch", "websearch", "task", "external_directory"] as const
const COLUMNS: Column[] = ["all", "build", "plan"]
const NEXT: Record<Action, Action> = { allow: "ask", ask: "deny", deny: "allow" }

/**
 * Permissions as one grid: tools down the side, the agents across, and in
 * every cell allow, ask or block. A click turns a cell to the next one and
 * saves it to the global config.
 */
export function LynxPermissions() {
  const language = useLanguage()
  const serverSync = useServerSync()
  const settings = useSettings()
  const [saving, setSaving] = createSignal<string>()
  const config = createMemo(() => serverSync().data.config as Config | undefined)

  const read = (rule: unknown): Action | undefined => {
    if (rule === "allow" || rule === "ask" || rule === "deny") return rule
    if (rule && typeof rule === "object" && "*" in rule) return read((rule as Record<string, unknown>)["*"])
    return undefined
  }
  const own = (column: Column, tool: string) => {
    const permission =
      column === "all" ? config()?.permission : (config()?.agent?.[column] as { permission?: unknown } | undefined)?.permission
    if (typeof permission === "string") return read(permission)
    return read((permission as Record<string, unknown> | undefined)?.[tool])
  }
  // A cell without its own rule follows the column to its left, ending at "ask".
  const value = (column: Column, tool: string): { action: Action; inherited: boolean } => {
    const mine = own(column, tool)
    if (mine) return { action: mine, inherited: false }
    if (column === "all") return { action: "ask", inherited: true }
    return { action: value("all", tool).action, inherited: true }
  }

  const cycle = async (column: Column, tool: string) => {
    const next = NEXT[value(column, tool).action]
    const patch = column === "all" ? { permission: { [tool]: next } } : { agent: { [column]: { permission: { [tool]: next } } } }
    setSaving(`${column}:${tool}`)
    await serverSync()
      .updateConfig(patch as Config)
      .catch((error: unknown) =>
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: String(error) }),
      )
    setSaving(undefined)
  }

  return (
    <div class="lynx-set">
      <header class="lynx-set-head">
        <h2>{language.t("lynx.set.tab.permissions")}</h2>
        <p>{language.t("lynx.set.permissions.lead")}</p>
      </header>
      <table class="lynx-matrix">
        <thead>
          <tr>
            <th />
            <For each={COLUMNS}>{(column) => <th>{language.t(`lynx.set.permissions.col.${column}` as never)}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={TOOLS}>
            {(tool) => (
              <tr>
                <td>
                  <b>{language.t(`lynx.set.permissions.tool.${tool}` as never)}</b>
                  <small>{tool}</small>
                </td>
                <For each={COLUMNS}>
                  {(column) => {
                    const cell = () => value(column, tool)
                    return (
                      <td>
                        <button
                          type="button"
                          class="lynx-cell"
                          data-action={cell().action}
                          data-inherited={cell().inherited ? "" : undefined}
                          data-saving={saving() === `${column}:${tool}` ? "" : undefined}
                          onClick={() => void cycle(column, tool)}
                        >
                          {language.t(`lynx.set.permissions.${cell().action}` as never)}
                        </button>
                      </td>
                    )
                  }}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <p class="lynx-set-mute">{language.t("lynx.set.permissions.legend")}</p>
      <section class="lynx-set-row">
        <div>
          <b>{language.t("lynx.set.permissions.autoTitle")}</b>
          <small>{language.t("lynx.set.permissions.autoHint")}</small>
        </div>
        <button
          type="button"
          class="lynx-switch lynx-switch-inline"
          aria-pressed={settings.permissions.autoApprove()}
          onClick={() => settings.permissions.setAutoApprove(!settings.permissions.autoApprove())}
        >
          <i class="lynx-switch-led" />
          <span class="lynx-switch-lever">
            <b />
          </span>
        </button>
      </section>
      <Show when={!config()}>
        <p class="lynx-set-mute">{language.t("common.loading")}</p>
      </Show>
    </div>
  )
}
