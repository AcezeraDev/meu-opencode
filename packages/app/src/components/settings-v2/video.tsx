import {
  choices,
  durations,
  fixedDuration,
  fps,
  resolutions,
  type Model,
} from "@opencode-ai/core/web-video/capabilities"
import { presetStyle } from "@opencode-ai/core/web-video/prompt"
import { build } from "@opencode-ai/core/web-video/request"
import {
  CAMERA_MOVEMENTS,
  DEFAULTS,
  MOTIONS,
  PRESETS,
  PURPOSES,
  QUALITIES,
  type Defaults,
} from "@opencode-ai/core/web-video/types"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { createMemo, createResource, createSignal, For, Show, type Accessor, type Component } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type Catalog = { configured: boolean; defaultModel: string; models: Model[]; error?: string }
type Choice = { value: string; label: string }

const AUTO = "auto"
// Stand-in starting frame for the cost preview: pricing never depends on the image.
const PREVIEW_IMAGE = "data:image/png;base64,"

function useWebVideoApi(directory: Accessor<string | undefined>) {
  const server = useServer()
  const platform = usePlatform()
  return (path: string, init?: { method: "PUT"; body: unknown }) => {
    const connection = server.current
    if (!connection) return Promise.reject(new Error("No server connection"))
    const url = new URL(`/experimental/web-video/${path}`, connection.http.url)
    const dir = directory()
    if (dir) url.searchParams.set("directory", dir)
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (connection.http.password)
      headers.Authorization = `Basic ${authTokenFromCredentials({ username: connection.http.username, password: connection.http.password })}`
    return (platform.fetch ?? fetch)(url, {
      method: init?.method ?? "GET",
      headers,
      body: init ? JSON.stringify(init.body) : undefined,
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    })
  }
}

export const SettingsVideoV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const api = useWebVideoApi(props.directory)
  const [settings, setSettings] = createStore<Defaults>({ ...DEFAULTS })
  const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved" | "error">("idle")

  // Errors are returned as data: a thrown resource error would reach the app's
  // root error boundary and replace the whole window with a crash screen.
  const [catalog] = createResource(async (): Promise<Catalog | { failed: true }> => {
    try {
      const [models, saved] = await Promise.all([
        api("models") as Promise<Catalog>,
        api("settings") as Promise<Defaults>,
      ])
      setSettings(reconcile({ ...DEFAULTS, ...saved }))
      return models
    } catch {
      return { failed: true }
    }
  })
  const loaded = () => {
    const value = catalog()
    return value && !("failed" in value) ? value : undefined
  }
  const failed = () => {
    const value = catalog()
    return !!value && "failed" in value
  }

  const model = createMemo(() => loaded()?.models.find((item) => item.id === settings.model))
  const models = createMemo(() =>
    (loaded()?.models ?? []).filter((item) => !settings.requireImage || item.imageToVideo),
  )

  // Saves go out one at a time and only the newest one touches the form, so a
  // slow response can't bring back a value the user has already changed.
  let queue = Promise.resolve()
  let latest = 0
  const save = (patch: Partial<Defaults>) => {
    setSettings(patch)
    setSaveState("saving")
    const id = ++latest
    queue = queue.then(() => {
      if (id !== latest) return
      return api("settings", { method: "PUT", body: { ...settings } }).then(
        (next: Defaults) => {
          if (id !== latest) return
          setSettings(reconcile({ ...DEFAULTS, ...next }))
          setSaveState("saved")
        },
        () => {
          if (id === latest) setSaveState("error")
        },
      )
    })
  }

  // Switching models keeps only settings the new model supports and turns FPS
  // on with the model's own default when it gains an FPS control.
  const modelPatch = (next: Model): Partial<Defaults> => {
    const allowed = durations(next)
    const nearest = allowed.length
      ? allowed.reduce((best, value) =>
          Math.abs(value - settings.duration) < Math.abs(best - settings.duration) ? value : best,
        )
      : settings.duration
    const fpsControl = fps(next)
    return {
      model: next.id,
      duration: nearest,
      resolution:
        settings.resolution && resolutions(next).includes(settings.resolution) ? settings.resolution : undefined,
      fps: fpsControl ? (settings.fps ?? fpsControl.default) : undefined,
      generateAudio: next.params.audio ? settings.generateAudio : false,
    }
  }
  const selectModel = (next: Model) => save(modelPatch(next))

  // Requiring a photo moves off a text-only model, preferring the default model.
  const setRequireImage = (value: boolean) => {
    const current = model()
    const all = loaded()?.models ?? []
    const fallback =
      value && current && !current.imageToVideo
        ? (all.find((item) => item.id === DEFAULTS.model && item.imageToVideo) ?? all.find((item) => item.imageToVideo))
        : undefined
    save({ requireImage: value, ...(fallback ? modelPatch(fallback) : {}) })
  }

  const preview = createMemo(() => {
    const current = model()
    if (!current) return
    const fromPhoto = settings.requireImage || !current.textToVideo
    if (fromPhoto && !current.imageToVideo) return
    return build(current, { prompt: "preview", referenceImage: fromPhoto ? PREVIEW_IMAGE : undefined }, { ...settings })
  })

  const costText = () => {
    const cost = preview()?.estimatedCost
    if (cost === undefined) return language.t("settings.video.cost.unavailable")
    return `~$${cost.toFixed(2)}`
  }

  const modelControlled = () => language.t("settings.video.controlledByModel")
  // The active style decides duration, motion and camera (the agent can still override per request).
  const style = createMemo(() => presetStyle(settings.preset)?.defaults)
  const styleControlled = () => language.t("settings.video.preset.controlled")
  const enumChoices = <T extends string>(values: readonly T[], prefix: string): Array<{ value: T; label: string }> =>
    values.map((value) => ({ value, label: language.t(`${prefix}.${value}` as Parameters<typeof language.t>[0]) }))

  const advanced = createMemo(() => {
    const current = model()
    if (!current) return []
    const params = current.params
    const range = (key: keyof typeof params) => {
      const parameter = params[key]
      if (!parameter) return
      if (parameter.options) return parameter.options.map((option) => option.label).join(", ")
      if (parameter.min !== undefined || parameter.max !== undefined)
        return `${parameter.min ?? "…"} – ${parameter.max ?? "…"}`
      return language.t("settings.video.advanced.free")
    }
    return (
      [
        ["fps", "settings.video.row.fps"],
        ["seed", "settings.video.advanced.seed"],
        ["inferenceSteps", "settings.video.advanced.inferenceSteps"],
        ["numFrames", "settings.video.advanced.numFrames"],
        ["negativePrompt", "settings.video.advanced.negativePrompt"],
        ["cameraFixed", "settings.video.advanced.cameraFixed"],
        ["cfg", "settings.video.advanced.cfg"],
        ["proMode", "settings.video.advanced.proMode"],
      ] as const
    ).flatMap(([key, label]) => {
      const detail = range(key)
      return detail ? [{ label: language.t(label), detail, field: params[key]?.name ?? key }] : []
    })
  })

  const [advancedOpen, setAdvancedOpen] = createSignal(false)

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.video.title")}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-video">
        <Show when={failed()}>
          <div class="settings-v2-video-notice" data-tone="error">
            {language.t("settings.video.loadError")}
          </div>
        </Show>

        <Show when={loaded()}>
          {(data) => (
            <>
              <div class="settings-v2-video-notice" data-tone={data().configured ? "ok" : "warn"}>
                {data().configured
                  ? language.t("settings.video.key.configured")
                  : language.t("settings.video.key.missing")}
              </div>
              <Show when={data().error}>
                {(error) => (
                  <div class="settings-v2-video-notice" data-tone="error">
                    {error()}
                  </div>
                )}
              </Show>

              <div class="settings-v2-section">
                <h3 class="settings-v2-section-title">{language.t("settings.video.section.generation")}</h3>
                <SettingsListV2>
                  <SettingsRowV2
                    title={language.t("settings.video.row.preset")}
                    description={language.t(`settings.video.preset.${settings.preset}.description`)}
                  >
                    <SelectV2
                      appearance="inline"
                      options={enumChoices(PRESETS, "settings.video.preset")}
                      current={enumChoices(PRESETS, "settings.video.preset").find(
                        (item) => item.value === settings.preset,
                      )}
                      value={(item) => item.value}
                      label={(item) => item.label}
                      placement="bottom-end"
                      gutter={6}
                      onSelect={(item) => item && save({ preset: item.value })}
                    />
                  </SettingsRowV2>

                  <SettingsRowV2
                    title={language.t("settings.video.row.requireImage")}
                    description={language.t("settings.video.row.requireImage.description")}
                  >
                    <Switch checked={settings.requireImage} onChange={setRequireImage} />
                  </SettingsRowV2>

                  <SettingsRowV2
                    title={language.t("settings.video.row.model")}
                    description={model()?.description ?? ""}
                  >
                    <SelectV2
                      appearance="inline"
                      options={models()}
                      current={model()}
                      value={(item) => item.id}
                      label={(item) => item.name}
                      placement="bottom-end"
                      gutter={6}
                      onSelect={(item) => item && selectModel(item)}
                    />
                  </SettingsRowV2>

                  <SettingsRowV2
                    title={language.t("settings.video.row.purpose")}
                    description={language.t("settings.video.row.purpose.description")}
                  >
                    <SelectV2
                      appearance="inline"
                      options={enumChoices(PURPOSES, "settings.video.purpose")}
                      current={enumChoices(PURPOSES, "settings.video.purpose").find(
                        (item) => item.value === settings.purpose,
                      )}
                      value={(item) => item.value}
                      label={(item) => item.label}
                      placement="bottom-end"
                      gutter={6}
                      onSelect={(item) => item && save({ purpose: item.value })}
                    />
                  </SettingsRowV2>

                  <SettingsRowV2 title={language.t("settings.video.row.duration")} description="">
                    <Show
                      when={!style()?.duration && model() && durations(model()!).length > 0}
                      fallback={
                        <span class="settings-v2-video-auto">
                          {style()?.duration && model() && durations(model()!).length > 0
                            ? `${preview()?.settings.duration ?? style()!.duration}s · ${styleControlled()}`
                            : model() && fixedDuration(model()!)
                              ? `${fixedDuration(model()!)}s · ${modelControlled()}`
                              : modelControlled()}
                        </span>
                      }
                    >
                      <SelectV2
                        appearance="inline"
                        numeric
                        options={durations(model()!).map((value) => ({ value: String(value), label: `${value}s` }))}
                        current={{ value: String(settings.duration), label: `${settings.duration}s` }}
                        value={(item) => item.value}
                        label={(item) => item.label}
                        placement="bottom-end"
                        gutter={6}
                        onSelect={(item) => item && save({ duration: Number(item.value) })}
                      />
                    </Show>
                  </SettingsRowV2>

                  <SettingsRowV2 title={language.t("settings.video.row.aspectRatio")} description="">
                    <Show
                      when={!settings.requireImage && model() && choices(model()!, "aspectRatio").length > 0}
                      fallback={
                        <span class="settings-v2-video-auto">
                          {settings.requireImage ? language.t("settings.video.aspect.fromPhoto") : modelControlled()}
                        </span>
                      }
                    >
                      <SelectV2
                        appearance="inline"
                        options={choices(model()!, "aspectRatio").map((value) => ({ value, label: value }))}
                        current={{ value: settings.aspectRatio, label: settings.aspectRatio }}
                        value={(item) => item.value}
                        label={(item) => item.label}
                        placement="bottom-end"
                        gutter={6}
                        onSelect={(item) => item && save({ aspectRatio: item.value })}
                      />
                    </Show>
                  </SettingsRowV2>

                  <SettingsRowV2
                    title={language.t("settings.video.row.quality")}
                    description={language.t("settings.video.row.quality.description")}
                  >
                    <SelectV2
                      appearance="inline"
                      options={enumChoices(QUALITIES, "settings.video.quality")}
                      current={enumChoices(QUALITIES, "settings.video.quality").find(
                        (item) => item.value === settings.quality,
                      )}
                      value={(item) => item.value}
                      label={(item) => item.label}
                      placement="bottom-end"
                      gutter={6}
                      onSelect={(item) => item && save({ quality: item.value })}
                    />
                  </SettingsRowV2>

                  <SettingsRowV2 title={language.t("settings.video.row.resolution")} description="">
                    <Show
                      when={model() && resolutions(model()!).length > 0}
                      fallback={<span class="settings-v2-video-auto">{modelControlled()}</span>}
                    >
                      <SelectV2
                        appearance="inline"
                        options={[
                          { value: AUTO, label: language.t("settings.video.auto.quality") },
                          ...resolutions(model()!).map((value) => ({ value, label: value })),
                        ]}
                        current={
                          settings.resolution
                            ? { value: settings.resolution, label: settings.resolution }
                            : { value: AUTO, label: language.t("settings.video.auto.quality") }
                        }
                        value={(item) => item.value}
                        label={(item) => item.label}
                        placement="bottom-end"
                        gutter={6}
                        onSelect={(item) => item && save({ resolution: item.value === AUTO ? undefined : item.value })}
                      />
                    </Show>
                  </SettingsRowV2>

                  <SettingsRowV2 title={language.t("settings.video.row.fps")} description="">
                    <Show
                      when={model() && fps(model()!)}
                      fallback={<span class="settings-v2-video-auto">{modelControlled()}</span>}
                    >
                      {(control) => (
                        <Show
                          when={control().values.length > 0}
                          fallback={
                            <Show
                              when={control().min !== undefined && control().max !== undefined}
                              fallback={
                                <input
                                  class="settings-v2-video-number"
                                  type="number"
                                  inputmode="numeric"
                                  value={settings.fps ?? control().default ?? ""}
                                  onChange={(event) => {
                                    const value = Number(event.currentTarget.value)
                                    save({ fps: Number.isFinite(value) && value > 0 ? value : undefined })
                                  }}
                                />
                              }
                            >
                              <div class="settings-v2-video-range">
                                <input
                                  type="range"
                                  min={control().min}
                                  max={control().max}
                                  value={settings.fps ?? control().default ?? control().min}
                                  onChange={(event) => save({ fps: Number(event.currentTarget.value) })}
                                />
                                <span>{settings.fps ?? control().default}</span>
                              </div>
                            </Show>
                          }
                        >
                          <SelectV2
                            appearance="inline"
                            numeric
                            options={[
                              { value: AUTO, label: language.t("settings.video.auto") },
                              ...control().values.map((value) => ({ value: String(value), label: `${value} fps` })),
                            ]}
                            current={
                              settings.fps
                                ? { value: String(settings.fps), label: `${settings.fps} fps` }
                                : { value: AUTO, label: language.t("settings.video.auto") }
                            }
                            value={(item) => item.value}
                            label={(item) => item.label}
                            placement="bottom-end"
                            gutter={6}
                            onSelect={(item) =>
                              item && save({ fps: item.value === AUTO ? undefined : Number(item.value) })
                            }
                          />
                        </Show>
                      )}
                    </Show>
                  </SettingsRowV2>
                </SettingsListV2>
              </div>

              <div class="settings-v2-section">
                <h3 class="settings-v2-section-title">{language.t("settings.video.section.style")}</h3>
                <SettingsListV2>
                  <SettingsRowV2 title={language.t("settings.video.row.motion")} description="">
                    <Show when={!style()} fallback={<span class="settings-v2-video-auto">{styleControlled()}</span>}>
                      <SelectV2
                        appearance="inline"
                        options={enumChoices(MOTIONS, "settings.video.motion")}
                        current={enumChoices(MOTIONS, "settings.video.motion").find(
                          (item) => item.value === settings.motion,
                        )}
                        value={(item) => item.value}
                        label={(item) => item.label}
                        placement="bottom-end"
                        gutter={6}
                        onSelect={(item) => item && save({ motion: item.value })}
                      />
                    </Show>
                  </SettingsRowV2>
                  <SettingsRowV2 title={language.t("settings.video.row.camera")} description="">
                    <Show when={!style()} fallback={<span class="settings-v2-video-auto">{styleControlled()}</span>}>
                      <SelectV2
                        appearance="inline"
                        options={enumChoices(CAMERA_MOVEMENTS, "settings.video.camera")}
                        current={enumChoices(CAMERA_MOVEMENTS, "settings.video.camera").find(
                          (item) => item.value === settings.cameraMovement,
                        )}
                        value={(item) => item.value}
                        label={(item) => item.label}
                        placement="bottom-end"
                        gutter={6}
                        onSelect={(item) => item && save({ cameraMovement: item.value })}
                      />
                    </Show>
                  </SettingsRowV2>
                  <SettingsRowV2
                    title={language.t("settings.video.row.scroll")}
                    description={language.t("settings.video.row.scroll.description")}
                  >
                    <Switch checked={settings.scrollFriendly} onChange={(value) => save({ scrollFriendly: value })} />
                  </SettingsRowV2>
                  <SettingsRowV2
                    title={language.t("settings.video.row.loop")}
                    description={language.t("settings.video.row.loop.description")}
                  >
                    <Switch checked={settings.loopFriendly} onChange={(value) => save({ loopFriendly: value })} />
                  </SettingsRowV2>
                  <SettingsRowV2
                    title={language.t("settings.video.row.audio")}
                    description={
                      model()?.params.audio
                        ? language.t("settings.video.row.audio.description")
                        : language.t("settings.video.row.audio.unsupported")
                    }
                  >
                    <Switch
                      checked={settings.generateAudio}
                      disabled={!model()?.params.audio}
                      onChange={(value) => save({ generateAudio: value })}
                    />
                  </SettingsRowV2>
                  <SettingsRowV2
                    title={language.t("settings.video.row.cost")}
                    description={language.t("settings.video.row.cost.description")}
                  >
                    <span class="settings-v2-video-cost">{costText()}</span>
                  </SettingsRowV2>
                </SettingsListV2>
              </div>

              <div class="settings-v2-section">
                <button
                  type="button"
                  class="settings-v2-video-advanced"
                  aria-expanded={advancedOpen()}
                  onClick={() => setAdvancedOpen((value) => !value)}
                >
                  {language.t("settings.video.section.advanced")} {advancedOpen() ? "▲" : "▼"}
                </button>
                <Show when={advancedOpen()}>
                  <p class="settings-v2-video-hint">{language.t("settings.video.advanced.hint")}</p>
                  <Show
                    when={advanced().length > 0}
                    fallback={<p class="settings-v2-video-hint">{language.t("settings.video.advanced.none")}</p>}
                  >
                    <SettingsListV2>
                      <For each={advanced()}>
                        {(item) => (
                          <SettingsRowV2 title={item.label} description={item.field}>
                            <span class="settings-v2-video-auto">{item.detail}</span>
                          </SettingsRowV2>
                        )}
                      </For>
                    </SettingsListV2>
                  </Show>
                </Show>
              </div>

              <p class="settings-v2-video-hint" role="status" aria-live="polite">
                <Show when={saveState() === "saving"}>{language.t("settings.video.saving")}</Show>
                <Show when={saveState() === "saved"}>{language.t("settings.video.saved")}</Show>
                <Show when={saveState() === "error"}>{language.t("settings.video.saveError")}</Show>
              </p>
            </>
          )}
        </Show>
      </div>
    </>
  )
}
