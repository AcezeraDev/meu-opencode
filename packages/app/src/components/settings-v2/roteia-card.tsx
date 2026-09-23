import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { createStore } from "solid-js/store"
import { type Accessor, type Component, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { authTokenFromCredentials } from "@/utils/server"

/** What the server tells about Roteia: never the key, only whether it works. */
interface RoteiaStatus {
  configured: boolean
  source?: "api" | "env" | "config"
  models: number
  check?: { ok: boolean; status?: number; message?: string }
}

/**
 * Roteia's card among the connected providers: where its key comes from, whether
 * Roteia accepts it, how many models loaded, and the actions to test, reload the
 * model list, change the key or disconnect. The key itself stays on the server;
 * the test runs there too.
 */
export const RoteiaCard: Component<{
  directory: Accessor<string | undefined>
  name: string
  /** Where the key comes from, labeled as on the other connected providers. */
  tag: string
  onChangeKey: () => void
  onDisconnect: () => void
}> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const platform = usePlatform()
  const serverSdk = useServerSDK()
  const [store, setStore] = createStore({
    status: undefined as RoteiaStatus | undefined,
    busy: undefined as "test" | "refresh" | undefined,
  })

  const load = async (test: boolean) => {
    const connection = server.current
    if (!connection) return
    const url = new URL("/experimental/roteia/status", connection.http.url)
    const directory = props.directory()
    if (directory) url.searchParams.set("directory", directory)
    if (test) url.searchParams.set("test", "1")
    const headers: Record<string, string> = {}
    if (connection.http.password)
      headers.Authorization = `Basic ${authTokenFromCredentials({ username: connection.http.username, password: connection.http.password })}`
    const status = await (platform.fetch ?? fetch)(url, { headers })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((value: RoteiaStatus | undefined) => value)
      .catch(() => undefined)
    if (status) setStore("status", status)
    if (!status && test)
      setStore("status", (current) => ({
        configured: current?.configured ?? true,
        source: current?.source,
        models: current?.models ?? 0,
        check: { ok: false, message: language.t("settings.providers.roteia.unreachable") },
      }))
  }

  const test = async () => {
    setStore("busy", "test")
    await load(true)
    setStore("busy", undefined)
  }

  // A new model list comes with the provider being loaded again, as after
  // connecting; Roteia's /v1/models is read then.
  const refresh = async () => {
    setStore("busy", "refresh")
    await serverSdk()
      .client.global.dispose()
      .catch(() => undefined)
    await load(true)
    setStore("busy", undefined)
  }

  onMount(() => void test())

  const state = () => {
    if (store.busy === "test" && !store.status?.check) return "checking"
    const check = store.status?.check
    if (!check) return "unknown"
    return check.ok ? "connected" : "error"
  }

  const statusText = () => {
    const current = state()
    if (current === "checking") return language.t("settings.providers.roteia.checking")
    if (current === "error") return store.status?.check?.message ?? language.t("settings.providers.roteia.unreachable")
    const models = store.status?.models ?? 0
    return current === "connected"
      ? language.plural("settings.providers.roteia.connected", models)
      : language.t("settings.providers.status.connected")
  }

  const keyText = () => {
    const source = store.status?.source
    if (source === "env") return language.t("settings.providers.roteia.key.env")
    if (source === "config") return language.t("settings.providers.roteia.key.config")
    return "••••••••••••"
  }

  return (
    <div class="settings-v2-provider-card settings-v2-roteia-card" data-variant="connected">
      <div class="settings-v2-provider-lead">
        <span class="settings-v2-provider-tile">
          <ProviderIcon id="roteia" width={16} height={16} class="settings-v2-provider-icon shrink-0" />
        </span>
        <div class="settings-v2-provider-copy">
          <div class="settings-v2-provider-main">
            <span class="settings-v2-provider-name truncate">{props.name}</span>
            <Tag>{props.tag}</Tag>
          </div>
          <span class="settings-v2-provider-status" data-state={state()} role="status">
            {statusText()}
          </span>
          <span class="settings-v2-roteia-key">
            {language.t("settings.providers.roteia.key.label")}{" "}
            <span class="settings-v2-roteia-key-value">{keyText()}</span>
          </span>
        </div>
      </div>
      <div class="settings-v2-roteia-actions">
        <ButtonV2 size="normal" variant="neutral" disabled={store.busy !== undefined} onClick={() => void test()}>
          {language.t("settings.providers.roteia.test")}
        </ButtonV2>
        <ButtonV2 size="normal" variant="neutral" disabled={store.busy !== undefined} onClick={() => void refresh()}>
          {store.busy === "refresh"
            ? language.t("settings.providers.roteia.refreshing")
            : language.t("settings.providers.roteia.refresh")}
        </ButtonV2>
        <Show when={store.status?.source !== "env"}>
          <ButtonV2 size="normal" variant="ghost-muted" onClick={props.onChangeKey}>
            {language.t("settings.providers.roteia.changeKey")}
          </ButtonV2>
          <ButtonV2 size="normal" variant="ghost-muted" onClick={props.onDisconnect}>
            {language.t("common.disconnect")}
          </ButtonV2>
        </Show>
      </div>
    </div>
  )
}
