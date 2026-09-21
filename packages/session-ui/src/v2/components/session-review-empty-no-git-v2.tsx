import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import "./session-review-v2.css"

export type SessionReviewEmptyNoGitV2Props = {
  pending: boolean
  onInitGit: () => void
}

export function SessionReviewEmptyNoGitV2(props: SessionReviewEmptyNoGitV2Props) {
  const i18n = useI18n()

  return (
    <div data-slot="session-review-v2-empty-no-git">
      <div data-slot="session-review-v2-empty-card" data-kind="no-git">
        <div data-slot="session-review-v2-empty-visual" aria-hidden="true">
          <span data-slot="session-review-v2-empty-orbit" />
          <Icon name="branch" size="large" />
          <span data-slot="session-review-v2-empty-node" data-position="start" />
          <span data-slot="session-review-v2-empty-node" data-position="middle" />
          <span data-slot="session-review-v2-empty-node" data-position="end" />
        </div>
        <div data-slot="session-review-v2-empty-copy">
          <div data-slot="session-review-v2-empty-no-git-title">{i18n.t("ui.sessionReviewV2.empty.noGit.title")}</div>
          <div data-slot="session-review-v2-empty-no-git-description">
            {i18n.t("ui.sessionReviewV2.empty.noGit.description")}
          </div>
        </div>
        <ButtonV2
          class="session-review-v2-empty-action"
          variant="neutral"
          size="normal"
          disabled={props.pending}
          onClick={props.onInitGit}
        >
          {props.pending
            ? i18n.t("ui.sessionReviewV2.empty.noGit.actionLoading")
            : i18n.t("ui.sessionReviewV2.empty.noGit.action")}
        </ButtonV2>
      </div>
    </div>
  )
}
