import { createMemo, For, Match, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { getRelativeTime } from "@/utils/time"
import { sessionPermissionRequest, sessionQuestionRequest } from "./composer/session-request-tree"
import "./session-mode.css"

const RAIL_LIMIT = 40

/** Cockpit mode's left rail: the project's sessions with live status. */
export function SessionRail(props: { current?: string }) {
  const sync = useSync()
  const sdk = useSDK()
  const permission = usePermission()
  const server = useServer()
  const tabs = useTabs()
  const language = useLanguage()

  const sessions = createMemo(() =>
    [...sync().data.session]
      .filter((session) => !session.parentID && !session.time.archived)
      .sort((a, b) => b.time.updated - a.time.updated)
      .slice(0, RAIL_LIMIT),
  )

  // Same rules as the composer: subagent sessions count, auto-accepted permissions don't.
  const state = (id: string) => {
    const data = sync().data
    const waitingPermission = sessionPermissionRequest(
      data.session,
      data.permission,
      id,
      (item) => !permission.autoResponds(item, sdk().directory),
    )
    if (waitingPermission || sessionQuestionRequest(data.session, data.question, id)) return "waiting"
    if (data.session_working(id)) return "running"
    return "idle"
  }

  const open = (sessionId: string) => {
    const tab = tabs.addSessionTab({ server: server.key, sessionId })
    tabs.select(tab)
  }

  return (
    <nav class="session-rail" aria-label={language.t("session.rail.title")}>
      <div class="session-rail-title">{language.t("session.rail.title")}</div>
      <div class="session-rail-list">
        <For each={sessions()}>
          {(session) => (
            <button
              type="button"
              class="session-rail-row"
              data-active={props.current === session.id ? "" : undefined}
              data-state={state(session.id)}
              aria-current={props.current === session.id ? "page" : undefined}
              onClick={() => open(session.id)}
            >
              <span class="session-rail-dot" aria-hidden="true" />
              <span class="session-rail-copy">
                <span class="session-rail-name">{session.title || language.t("command.session.new")}</span>
                <span class="session-rail-meta">
                  <Switch fallback={getRelativeTime(new Date(session.time.updated).toISOString(), language.t)}>
                    <Match when={state(session.id) === "running"}>{language.t("session.rail.status.running")}</Match>
                    <Match when={state(session.id) === "waiting"}>{language.t("session.rail.status.waiting")}</Match>
                  </Switch>
                </span>
              </span>
            </button>
          )}
        </For>
      </div>
    </nav>
  )
}
