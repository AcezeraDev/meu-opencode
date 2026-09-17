import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useNavigate } from "@solidjs/router"
import { For } from "solid-js"
import { useLanguage } from "@/context/language"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"
import "./home/home.css"

const HOME_EXAMPLES = ["prompt.example.2", "prompt.example.4", "prompt.example.3"] as const

export function NewHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const language = useLanguage()
  const navigate = useNavigate()

  return (
    <div
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <ScrollView
        class="h-full [container-type:size]"
        thumbContainer={scroll.viewport.thumbTrack}
        thumbHoverTarget={scroll.viewport.hoverTarget}
        viewportRef={scroll.viewport.setViewport}
        onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <section class="home-hero" data-disabled={sessions.session.canCreate() ? undefined : ""}>
          <button
            type="button"
            class="home-hero-composer"
            disabled={!sessions.session.canCreate()}
            onClick={() => home.project.openNewSession()}
          >
            <span class="home-hero-placeholder">{language.t("prompt.placeholder.simple")}</span>
            <span class="home-hero-send" aria-hidden="true">
              <Icon name="chevron-down" />
            </span>
          </button>
          <div class="home-hero-examples">
            <For each={HOME_EXAMPLES}>
              {(key) => (
                <button
                  type="button"
                  class="home-hero-example"
                  disabled={!sessions.session.canCreate()}
                  onClick={() => home.project.openNewSessionWithPrompt(language.t(key))}
                >
                  {language.t(key)}
                </button>
              )}
            </For>
          </div>
          <button type="button" class="home-hero-board" onClick={() => navigate("/board")}>
            <Icon name="grid-plus" size="small" />
            {language.t("board.open")}
          </button>
        </section>
        <div
          class={`
            mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3
            lg:grid-cols-[300px_minmax(0,700px)] lg:grid-rows-1 lg:gap-8 lg:px-6
          `}
        >
          <HomeProjects projects={projects} scroll={scroll} />
          <HomeSessions sessions={sessions} search={search} scroll={scroll} />
          <HomeUtilityNav
            class="flex lg:hidden"
            onOpenSettings={projects.utility.settings}
            onOpenHelp={projects.utility.help}
            language={projects.copy.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}
