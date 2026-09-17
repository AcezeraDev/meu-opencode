import { Icon } from "@opencode-ai/ui/v2/icon"
import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { ServerConnection } from "@/context/server"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { getRelativeTime } from "@/utils/time"
import { createHomeController } from "./home/home-controller"
import { createHomeSessionsController, type HomeSessionRecord } from "./home/home-sessions-controller"
import "./board.css"

type BoardState = "running" | "waiting" | "idle"

type BoardItem = {
  record: HomeSessionRecord
  state: BoardState
  reason?: "permission" | "question"
  progress?: { done: number; total: number }
}

const COLUMNS = [
  { id: "running", key: "board.column.running" },
  { id: "waiting", key: "board.column.waiting" },
  { id: "idle", key: "board.column.idle" },
] as const

/**
 * Every session across the focused server's projects, grouped by what it needs:
 * running, waiting on the user (permission or question), or finished.
 * Sessions come from the same index the home page uses; status uses the same
 * request lookups as the tab avatars, so auto-accepted permissions don't count.
 */
export function SessionBoard() {
  const home = createHomeController()
  const sessions = createHomeSessionsController(home)
  const global = useGlobal()
  const permission = usePermission()
  const language = useLanguage()
  const navigate = useNavigate()
  const [filter, setFilter] = createSignal<string>()

  const records = createMemo(() => sessions.data.groups().flatMap((group) => group.sessions))
  const projects = createMemo(() => [...new Set(records().map((record) => record.projectName))])

  const inspect = (record: HomeSessionRecord): BoardItem => {
    const conn = home.server.focused()
    if (!conn) return { record, state: "idle" }
    const serverSync = global.ensureServerCtx(conn).sync
    const permissionState = permission.ensureServerState(ServerConnection.key(conn))
    const directory = record.session.directory
    const id = record.session.id
    const [store] = serverSync.child(directory, { bootstrap: false })
    const todos = serverSync.session.data.todo[id] ?? []
    const progress =
      todos.length > 0
        ? { done: todos.filter((todo) => todo.status === "completed").length, total: todos.length }
        : undefined
    const needsPermission = sessionPermissionRequest(
      store.session,
      serverSync.session.data.permission,
      id,
      (item) => !permissionState.autoResponds(item, directory),
    )
    if (needsPermission) return { record, state: "waiting", reason: "permission", progress }
    if (sessionQuestionRequest(store.session, serverSync.session.data.question, id))
      return { record, state: "waiting", reason: "question", progress }
    if (serverSync.session.data.session_working(id)) return { record, state: "running", progress }
    return { record, state: "idle", progress }
  }

  const items = createMemo(() =>
    records()
      .filter((record) => !filter() || record.projectName === filter())
      .map(inspect),
  )
  const column = (state: BoardState) => items().filter((item) => item.state === state)

  return (
    <div class="session-board">
      <header class="session-board-header">
        <button
          type="button"
          class="session-board-back"
          aria-label={language.t("board.back")}
          onClick={() => navigate("/")}
        >
          <Icon name="chevron-down" />
        </button>
        <div class="session-board-heading">
          <h1>{language.t("board.title")}</h1>
          <span>{language.t("board.summary", { projects: projects().length, sessions: records().length })}</span>
        </div>
        <div class="session-board-filters">
          <button
            type="button"
            class="session-board-chip"
            data-active={filter() ? undefined : ""}
            onClick={() => setFilter(undefined)}
          >
            {language.t("board.filter.all")}
          </button>
          <For each={projects()}>
            {(name) => (
              <button
                type="button"
                class="session-board-chip"
                data-active={filter() === name ? "" : undefined}
                onClick={() => setFilter(name)}
              >
                {name}
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="session-board-new"
          disabled={!sessions.session.canCreate()}
          onClick={() => home.project.openNewSession()}
        >
          <Icon name="plus" size="small" />
          {language.t("command.session.new")}
        </button>
      </header>

      <div class="session-board-columns">
        <For each={COLUMNS}>
          {(col) => (
            <section class="session-board-column" data-state={col.id}>
              <header class="session-board-column-header">
                <span class="session-board-dot" aria-hidden="true" />
                <span>{language.t(col.key)}</span>
                <span class="session-board-count">{column(col.id).length}</span>
              </header>
              <div class="session-board-cards">
                <Show
                  when={column(col.id).length > 0}
                  fallback={<div class="session-board-empty">{language.t("board.column.empty")}</div>}
                >
                  <For each={column(col.id)}>
                    {(item) => (
                      <article class="session-board-card" data-state={item.state}>
                        <button
                          type="button"
                          class="session-board-card-main"
                          onClick={() => sessions.session.open(item.record.session)}
                        >
                          <span class="session-board-card-meta">
                            <span class="session-board-tag">{item.record.projectName}</span>
                            <span class="session-board-time">
                              {getRelativeTime(new Date(item.record.session.time.updated).toISOString(), language.t)}
                            </span>
                          </span>
                          <span class="session-board-card-title">
                            {item.record.session.title || language.t("command.session.new")}
                          </span>
                          <Show when={item.reason}>
                            {(reason) => (
                              <span class="session-board-reason">
                                {language.t(
                                  reason() === "permission" ? "board.reason.permission" : "board.reason.question",
                                )}
                              </span>
                            )}
                          </Show>
                          <Show when={item.progress}>
                            {(progress) => (
                              <span class="session-board-progress">
                                <span class="session-board-bar">
                                  <span style={{ width: `${(progress().done / progress().total) * 100}%` }} />
                                </span>
                                <span>
                                  {language.t("board.progress", { done: progress().done, total: progress().total })}
                                </span>
                              </span>
                            )}
                          </Show>
                        </button>
                        <Show when={item.state === "idle"}>
                          <button
                            type="button"
                            class="session-board-archive"
                            aria-label={language.t("command.session.archive")}
                            onClick={() => void sessions.session.archive(item.record.session)}
                          >
                            <Icon name="archive" size="small" />
                          </button>
                        </Show>
                      </article>
                    )}
                  </For>
                </Show>
              </div>
            </section>
          )}
        </For>
      </div>
    </div>
  )
}
