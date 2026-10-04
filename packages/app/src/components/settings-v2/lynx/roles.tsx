import type { Config } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import { createUsdBrlRate } from "@/components/exchange-rate"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServerSync } from "@/context/server-sync"
import { fold } from "./overview"
import { showToast } from "@/utils/toast"
import "./lynx-settings.css"

const ROLES = ["coding", "fast", "reasoning", "vision", "evaluation", "writing"] as const
type Role = (typeof ROLES)[number]

/** The config keeps roles in `models`, and the two oldest under their own names. */
type RolesConfig = Config & { models?: Partial<Record<Role, string>> }

/**
 * Which model does what: every role is a slot and every model a card.
 * Drag a card onto a slot, or pick a slot and click a card. The price shows
 * per million words of answer, in the person's money.
 */
export function LynxRoles() {
  const language = useLanguage()
  const models = useModels()
  const serverSync = useServerSync()
  const rate = createUsdBrlRate()
  const [picked, setPicked] = createSignal<Role>("writing")
  const [filter, setFilter] = createSignal("")
  const [over, setOver] = createSignal<Role>()
  const config = createMemo(() => serverSync().data.config as RolesConfig | undefined)

  const current = (role: Role) => {
    if (role === "coding") return config()?.model ?? config()?.models?.coding
    if (role === "fast") return config()?.small_model ?? config()?.models?.fast
    return config()?.models?.[role]
  }
  const label = (key?: string) => {
    if (!key) return undefined
    const [provider, ...rest] = key.split("/")
    const id = rest.join("/")
    return models.list().find((model) => model.provider.id === provider && model.id === id)?.name ?? key
  }
  const price = (model: { cost?: { output?: number } }) => {
    const usd = model.cost?.output
    if (usd === undefined) return undefined
    if (usd === 0) return language.t("lynx.set.roles.free")
    const value = new Intl.NumberFormat(language.intl(), { style: "currency", currency: "BRL" }).format(usd * (rate() ?? 5))
    return language.t("lynx.set.roles.price", { value })
  }
  const list = createMemo(() => {
    const words = fold(filter()).split(/\s+/).filter(Boolean)
    return models
      .list()
      .filter((model) => models.visible({ modelID: model.id, providerID: model.provider.id }))
      .filter((model) => words.every((word) => fold(`${model.name} ${model.provider.name}`).includes(word)))
      .slice(0, 60)
  })

  const assign = async (role: Role, key: string) => {
    const patch: RolesConfig =
      role === "coding" ? { model: key } : role === "fast" ? { small_model: key } : { models: { [role]: key } }
    await serverSync()
      .updateConfig(patch as Config)
      .then(() => showToast({ variant: "success", title: language.t("lynx.set.roles.saved", { role: language.t(`lynx.set.roles.${role}` as never), model: label(key) ?? key }) }))
      .catch((error: unknown) => showToast({ variant: "error", title: language.t("common.requestFailed"), description: String(error) }))
  }

  return (
    <div class="lynx-set">
      <header class="lynx-set-head">
        <h2>{language.t("lynx.set.tab.roles")}</h2>
        <p>{language.t("lynx.set.roles.lead")}</p>
      </header>
      <div class="lynx-slots">
        <For each={ROLES}>
          {(role) => (
            <button
              type="button"
              class="lynx-slot"
              aria-pressed={picked() === role}
              data-over={over() === role ? "" : undefined}
              onClick={() => setPicked(role)}
              onDragOver={(event) => {
                event.preventDefault()
                setOver(role)
              }}
              onDragLeave={() => setOver(undefined)}
              onDrop={(event) => {
                event.preventDefault()
                setOver(undefined)
                const key = event.dataTransfer?.getData("text/plain")
                if (key) void assign(role, key)
              }}
            >
              <span class="lynx-set-label">{language.t(`lynx.set.roles.${role}` as never)}</span>
              <Show when={current(role)} fallback={<span class="lynx-slot-empty">{language.t("lynx.set.roles.empty")}</span>}>
                <b class="lynx-slot-model">{label(current(role))}</b>
              </Show>
              <small>{language.t(`lynx.set.roles.${role}.hint` as never)}</small>
            </button>
          )}
        </For>
      </div>
      <div class="lynx-set-row-head">
        <span class="lynx-set-label">
          {language.t("lynx.set.roles.pick", { role: language.t(`lynx.set.roles.${picked()}` as never) })}
        </span>
        <input
          class="lynx-search"
          value={filter()}
          placeholder={language.t("dialog.model.search.placeholder")}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />
      </div>
      <div class="lynx-cards">
        <For each={list()}>
          {(model) => {
            const key = `${model.provider.id}/${model.id}`
            return (
              <button
                type="button"
                class="lynx-model"
                draggable={true}
                data-current={current(picked()) === key ? "" : undefined}
                onDragStart={(event) => event.dataTransfer?.setData("text/plain", key)}
                onClick={() => void assign(picked(), key)}
              >
                <b>{model.name}</b>
                <small>{model.provider.name}</small>
                <Show when={price(model as { cost?: { output?: number } })}>
                  {(value) => <span class="lynx-model-price">{value()}</span>}
                </Show>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}
