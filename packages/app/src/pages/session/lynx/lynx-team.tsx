import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { sessionTitle } from "@/utils/session-title"

/**
 * When Lynx splits the work, each helper gets a lane of its own: its name,
 * what it is doing right now and a bar that runs while it works, and a line
 * saying Lynx gathers everything once they are all done.
 */
export function LynxTeam(props: { sessionID?: string }) {
  const sync = useSync()
  const language = useLanguage()
  const helpers = createMemo(() => {
    const id = props.sessionID
    if (!id) return []
    const children = sync().data.session.filter((session) => session.parentID === id)
    return children.map((session) => {
      const messages = sync().data.message[session.id] ?? []
      const tools = messages.flatMap((message) =>
        (sync().data.part[message.id] ?? []).filter((part) => part.type === "tool"),
      )
      const last = tools.at(-1)
      return {
        id: session.id,
        name: (sessionTitle(session.title) ?? "").replace(/\s*\(@?(\w+) subagent\)\s*$/, "") || session.id,
        doing: last?.type === "tool" ? (last.state.status === "completed" ? last.state.title : "") || last.tool : "",
        steps: tools.length,
        working: (sync().data.session_status[session.id]?.type ?? "idle") !== "idle",
      }
    })
  })
  const working = () => helpers().filter((helper) => helper.working).length

  return (
    <Show when={working() > 0}>
      <section class="lynx-team" data-motion="l" aria-live="polite">
        <span class="lynx-team-label">
          {language.t(working() === 1 ? "lynx.team.working.one" : "lynx.team.working", { count: working() })}
        </span>
        <For each={helpers()}>
          {(helper, index) => (
            <div class="lynx-team-lane" data-done={helper.working ? undefined : ""} style={{ "--d": `${index() * 80}ms` }}>
              <span class="lynx-team-avatar">{helper.working ? "›" : "✓"}</span>
              <div class="lynx-team-body">
                <b>{helper.name}</b>
                <span>
                  {helper.doing || language.t("lynx.team.starting")}
                  {helper.steps ? ` · ${language.t(helper.steps === 1 ? "lynx.team.steps.one" : "lynx.team.steps", { count: helper.steps })}` : ""}
                </span>
                <i class="lynx-team-bar" style={{ "animation-duration": `${2.4 + index() * 0.9}s` }} />
              </div>
            </div>
          )}
        </For>
        <span class="lynx-team-merge">
          <i />
          {language.t("lynx.team.merge")}
        </span>
      </section>
    </Show>
  )
}
