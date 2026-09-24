import type { Agent, AgentRuntime, AgentWriteInput } from "@opencode-ai/sdk/v2/client"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { agentLabel } from "@opencode-ai/ui/context/i18n"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ModelSelectorPopoverV2, type ModelSelectorState } from "@/components/dialog-select-model"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { createHomeController } from "@/pages/home/home-controller"
import { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import "./agents.css"

const PERMISSIONS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "websearch",
  "lsp",
  "skill",
  "browser",
] as const

type Permission = (typeof PERMISSIONS)[number]
type Form = Omit<AgentWriteInput, "description"> & { name: string; description: string; generating: string }

const emptyForm = (): Form => ({
  name: "",
  description: "",
  mode: "all",
  prompt: "",
  color: "#6f7bf7",
  permissions: [...PERMISSIONS],
  generating: "",
})

const permissionAllowed = (agent: Agent, permission: Permission) =>
  agent.permission.filter((rule) => rule.permission === "*" || rule.permission === permission).at(-1)?.action !== "deny"

export function AgentsPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const dialog = useDialog()
  const models = useModels()
  const home = createHomeController()
  const [form, setForm] = createStore<Form>(emptyForm())
  const [state, setState] = createStore({
    editing: false,
    existing: false,
    saving: false,
    generating: false,
    toggling: "",
  })

  const source = createMemo(() => {
    const context = home.server.focusedContext()
    const directory = home.project.newSession()?.worktree
    if (!context || !directory) return
    return { context, directory }
  })
  const [agents, agentsAction] = createResource(source, async (input) => {
    const result = await input.context.sdk.client.app.agents({ directory: input.directory })
    const list = (result.data ?? []).filter((agent) => !agent.hidden)
    input.context.sync.child(input.directory, { bootstrap: false })[1]("agent", list)
    return list
  })
  const [runtimes, runtimesAction] = createResource(source, async (input) => {
    const result = await input.context.sdk.client.app.agentRuntime({ directory: input.directory })
    return result.data ?? []
  })

  const poll = window.setInterval(() => {
    if (!source()) return
    void runtimesAction.refetch()
  }, 2_000)
  onCleanup(() => window.clearInterval(poll))

  const nativeAgents = createMemo(() => agents()?.filter((agent) => agent.native) ?? [])
  const userAgents = createMemo(() => agents()?.filter((agent) => !agent.native) ?? [])
  const runtimeByName = createMemo(() => new Map((runtimes() ?? []).map((runtime) => [runtime.name, runtime])))
  const activeCount = createMemo(() => (runtimes() ?? []).filter((runtime) => runtime.enabled).length)
  const slugValid = createMemo(() => /^[a-z0-9-]+$/.test(form.name))
  const canSave = createMemo(() => slugValid() && form.prompt.trim().length > 0 && !state.saving)
  const selectedModel = createMemo(() => (form.model ? models.find(form.model) : undefined))
  const modelState: ModelSelectorState = {
    current: selectedModel,
    list: models.list,
    visible: models.visible,
    set(model, options) {
      setForm("model", model)
      if (model && options?.recent) models.recent.push(model)
    },
  }

  const startCreate = () => {
    setForm(emptyForm())
    setState({ editing: true, existing: false })
  }

  const startEdit = (agent: Agent) => {
    setForm({
      name: agent.name,
      description: agent.description ?? "",
      mode: agent.mode,
      model: agent.model,
      variant: agent.variant,
      prompt: agent.prompt ?? "",
      temperature: agent.temperature,
      topP: agent.topP,
      color: agent.color ?? "#6f7bf7",
      options: agent.options,
      steps: agent.steps,
      permissions: PERMISSIONS.filter((permission) => permissionAllowed(agent, permission)),
      generating: "",
    })
    setState({ editing: true, existing: true })
  }

  const refresh = async () => {
    await agentsAction.refetch()
  }

  const save = async () => {
    const input = source()
    if (!input || !canSave()) return
    setState("saving", true)
    try {
      await input.context.sdk.client.app.agentUpdate({
        name: form.name,
        directory: input.directory,
        agentWriteInput: {
          description: form.description.trim() || undefined,
          mode: form.mode,
          model: form.model,
          variant: form.variant,
          prompt: form.prompt,
          temperature: form.temperature,
          topP: form.topP,
          color: form.color || undefined,
          options: form.options,
          steps: form.steps,
          permissions: form.permissions,
        },
      })
      await refresh()
      setState({ editing: false, existing: false })
      showToast({ variant: "success", title: language.t("agents.toast.saved") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setState("saving", false)
    }
  }

  const generate = async () => {
    const input = source()
    if (!input || !form.generating.trim() || state.generating) return
    setState("generating", true)
    try {
      const result = await input.context.sdk.client.app.agentGenerate({
        directory: input.directory,
        agentGenerateInput: { description: form.generating.trim(), model: form.model },
      })
      if (!result.data) return
      setForm({
        name: state.existing ? form.name : result.data.identifier,
        description: result.data.whenToUse,
        prompt: result.data.systemPrompt,
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("agents.generate.error"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setState("generating", false)
    }
  }

  const remove = async (name: string) => {
    const input = source()
    if (!input) return
    try {
      await input.context.sdk.client.app.agentDelete({ name, directory: input.directory })
      await refresh()
      setState({ editing: false, existing: false })
      dialog.close()
      showToast({ variant: "success", title: language.t("agents.toast.deleted") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t),
      })
    }
  }

  const confirmRemove = (name: string) => {
    dialog.show(() => (
      <DialogV2 fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("agents.delete.title")}
            description={language.t("agents.delete.confirm", { name })}
          />
        </DialogHeader>
        <DialogFooter>
          <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 variant="danger" onClick={() => void remove(name)}>
            {language.t("agents.delete.action")}
          </ButtonV2>
        </DialogFooter>
      </DialogV2>
    ))
  }

  const toggleRuntime = async (agent: Agent) => {
    const input = source()
    if (!input || agent.mode === "subagent" || state.toggling) return
    const enabled = !runtimeByName().get(agent.name)?.enabled
    setState("toggling", agent.name)
    try {
      await input.context.sdk.client.app.agentRuntimeUpdate({
        name: agent.name,
        directory: input.directory,
        agentRuntimeUpdateInput: { enabled },
      })
      await runtimesAction.refetch()
      showToast({
        variant: "success",
        title: language.t(enabled ? "agents.runtime.started" : "agents.runtime.stopped"),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setState("toggling", "")
    }
  }

  const openRuntimeSession = (runtime: AgentRuntime) => {
    const connection = home.server.focused()
    if (!connection || !runtime.sessionID) return
    navigate(sessionHref(ServerConnection.key(connection), runtime.sessionID))
  }

  const card = (agent: Agent) => {
    const runtime = () => runtimeByName().get(agent.name)
    const active = () => runtime()?.enabled === true
    return (
      <article class="agents-card" data-native={agent.native ? "" : undefined} data-running={active() ? "" : undefined}>
        <div class="agents-card-accent" style={{ "background-color": agent.color ?? "var(--icon-base)" }} />
        <div class="agents-card-body">
          <div class="agents-card-heading">
            <div>
              <h3>{agentLabel(language.t, agent.name)}</h3>
              <span class="agents-card-mode">{language.t(`agents.mode.${agent.mode}`)}</span>
            </div>
            <Show when={agent.native}>
              <span class="agents-readonly">{language.t("agents.readonly")}</span>
            </Show>
          </div>
          <div class="agents-runtime-state" data-status={runtime()?.status ?? "stopped"}>
            <span class="agents-runtime-dot" />
            <strong>{language.t(`agents.runtime.status.${runtime()?.status ?? "stopped"}`)}</strong>
            <Show when={runtime()?.enabled && runtime()?.cycles !== undefined}>
              <span>{language.t("agents.runtime.cycles", { count: runtime()?.cycles ?? 0 })}</span>
            </Show>
          </div>
          <p>{agent.description || language.t("agents.description.empty")}</p>
          <div class="agents-card-model">
            <Icon name="models" size="small" />
            <span>
              {agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : language.t("agents.model.default")}
            </span>
          </div>
          <Show when={runtime()?.error}>{(error) => <div class="agents-runtime-error">{error()}</div>}</Show>
        </div>
        <div class="agents-card-actions">
          <ButtonV2
            variant={active() ? "neutral" : "contrast"}
            disabled={agent.mode === "subagent" || !home.project.newSession() || !!state.toggling}
            onClick={() => void toggleRuntime(agent)}
          >
            {language.t(
              agent.mode === "subagent"
                ? "agents.run.unavailable"
                : state.toggling === agent.name
                  ? "agents.runtime.changing"
                  : active()
                    ? "agents.runtime.stop"
                    : "agents.runtime.start",
            )}
          </ButtonV2>
          <Show when={runtime()?.sessionID}>
            <ButtonV2 variant="ghost" onClick={() => openRuntimeSession(runtime()!)}>
              {language.t("agents.runtime.openSession")}
            </ButtonV2>
          </Show>
          <Show when={!agent.native}>
            <ButtonV2 variant="ghost" onClick={() => startEdit(agent)}>
              {language.t("agents.edit")}
            </ButtonV2>
          </Show>
        </div>
      </article>
    )
  }

  return (
    <main class="agents-page">
      <header class="agents-header">
        <button class="agents-back" type="button" aria-label={language.t("agents.back")} onClick={() => navigate("/")}>
          <Icon name="arrow-left" />
        </button>
        <div>
          <h1>{language.t("agents.title")}</h1>
          <p>{language.t("agents.subtitle")}</p>
        </div>
        <ButtonV2 variant="contrast" icon="plus" onClick={startCreate}>
          {language.t("agents.create")}
        </ButtonV2>
      </header>

      <div class="agents-workspace" data-editor={state.editing ? "" : undefined}>
        <section class="agents-catalog" aria-label={language.t("agents.catalog")}>
          <div class="agents-runtime-summary" data-active={activeCount() > 0 ? "" : undefined}>
            <div class="agents-runtime-summary-icon">
              <span />
            </div>
            <div>
              <strong>{language.t("agents.runtime.summary.title")}</strong>
              <span>
                {language.t(activeCount() > 0 ? "agents.runtime.summary.active" : "agents.runtime.summary.inactive", {
                  count: activeCount(),
                })}
              </span>
            </div>
            <small>{language.t("agents.runtime.summary.scope")}</small>
          </div>
          <Show when={!agents.loading} fallback={<div class="agents-loading">{language.t("agents.loading")}</div>}>
            <Show
              when={(agents()?.length ?? 0) > 0}
              fallback={<div class="agents-empty">{language.t("agents.empty")}</div>}
            >
              <Show when={userAgents().length > 0}>
                <div class="agents-section-heading">
                  <h2>{language.t("agents.section.yours")}</h2>
                  <span>{userAgents().length}</span>
                </div>
                <div class="agents-grid">
                  <For each={userAgents()}>{card}</For>
                </div>
              </Show>
              <Show when={nativeAgents().length > 0}>
                <div class="agents-section-heading agents-section-heading-native">
                  <h2>{language.t("agents.section.native")}</h2>
                  <span>{nativeAgents().length}</span>
                </div>
                <div class="agents-grid">
                  <For each={nativeAgents()}>{card}</For>
                </div>
              </Show>
            </Show>
          </Show>
        </section>

        <Show when={state.editing}>
          <aside class="agents-editor">
            <div class="agents-editor-header">
              <div>
                <span>{language.t(state.existing ? "agents.editor.editing" : "agents.editor.creating")}</span>
                <h2>{state.existing ? form.name : language.t("agents.editor.new")}</h2>
              </div>
              <button type="button" aria-label={language.t("common.close")} onClick={() => setState("editing", false)}>
                <Icon name="close" />
              </button>
            </div>

            <div class="agents-generator">
              <label for="agent-generation">{language.t("agents.generate.label")}</label>
              <div>
                <input
                  id="agent-generation"
                  value={form.generating}
                  placeholder={language.t("agents.generate.placeholder")}
                  onInput={(event) => setForm("generating", event.currentTarget.value)}
                />
                <ButtonV2
                  variant="neutral"
                  disabled={!form.generating.trim() || state.generating}
                  onClick={() => void generate()}
                >
                  {language.t(state.generating ? "agents.generate.running" : "agents.generate.action")}
                </ButtonV2>
              </div>
              <p>{language.t("agents.generate.hint")}</p>
            </div>

            <div class="agents-form">
              <label>
                <span>{language.t("agents.field.name")}</span>
                <input
                  value={form.name}
                  disabled={state.existing}
                  aria-invalid={form.name.length > 0 && !slugValid()}
                  onInput={(event) => setForm("name", event.currentTarget.value.toLowerCase())}
                />
                <Show when={form.name.length > 0 && !slugValid()}>
                  <small>{language.t("agents.field.name.invalid")}</small>
                </Show>
              </label>
              <label>
                <span>{language.t("agents.field.description")}</span>
                <input
                  value={form.description}
                  onInput={(event) => setForm("description", event.currentTarget.value)}
                />
              </label>

              <div class="agents-form-row">
                <div class="agents-field">
                  <span>{language.t("agents.field.model")}</span>
                  <ModelSelectorPopoverV2
                    model={modelState}
                    trigger={(props) => (
                      <button {...props} type="button" class="agents-model-trigger">
                        <span>{selectedModel()?.name ?? language.t("agents.model.default")}</span>
                        <Icon name="selector" size="small" />
                      </button>
                    )}
                  />
                </div>
                <label>
                  <span>{language.t("agents.field.temperature")}</span>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={form.temperature ?? ""}
                    onInput={(event) =>
                      setForm("temperature", event.currentTarget.value ? event.currentTarget.valueAsNumber : undefined)
                    }
                  />
                </label>
                <label class="agents-color-field">
                  <span>{language.t("agents.field.color")}</span>
                  <input
                    type="color"
                    value={form.color}
                    onInput={(event) => setForm("color", event.currentTarget.value)}
                  />
                </label>
              </div>

              <fieldset class="agents-mode">
                <legend>{language.t("agents.field.mode")}</legend>
                <For each={["all", "primary", "subagent"] as const}>
                  {(mode) => (
                    <button
                      type="button"
                      data-active={form.mode === mode ? "" : undefined}
                      onClick={() => setForm("mode", mode)}
                    >
                      {language.t(`agents.mode.${mode}`)}
                    </button>
                  )}
                </For>
              </fieldset>

              <label>
                <span>{language.t("agents.field.prompt")}</span>
                <textarea value={form.prompt} onInput={(event) => setForm("prompt", event.currentTarget.value)} />
              </label>

              <fieldset class="agents-permissions">
                <legend>{language.t("agents.field.permissions")}</legend>
                <For each={PERMISSIONS}>
                  {(permission) => (
                    <label>
                      <input
                        type="checkbox"
                        checked={form.permissions.includes(permission)}
                        onChange={(event) =>
                          setForm(
                            "permissions",
                            event.currentTarget.checked
                              ? [...form.permissions, permission]
                              : form.permissions.filter((item) => item !== permission),
                          )
                        }
                      />
                      <span>{permission}</span>
                    </label>
                  )}
                </For>
              </fieldset>
            </div>

            <div class="agents-editor-actions">
              <Show when={state.existing}>
                <ButtonV2 variant="danger" onClick={() => confirmRemove(form.name)}>
                  {language.t("agents.delete.action")}
                </ButtonV2>
              </Show>
              <div />
              <ButtonV2 variant="ghost" onClick={() => setState("editing", false)}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="contrast" disabled={!canSave()} onClick={() => void save()}>
                {language.t(state.saving ? "agents.saving" : "agents.save")}
              </ButtonV2>
            </div>
          </aside>
        </Show>
      </div>
    </main>
  )
}
