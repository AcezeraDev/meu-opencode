import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Icon } from "@opencode-ai/ui/v2/icon"
import "./session-review-v2.css"

export function SessionReviewEmptyChangesV2() {
  const i18n = useI18n()

  return (
    <div data-slot="session-review-v2-empty-changes">
      <div data-slot="session-review-v2-empty-card" data-kind="changes">
        <div data-slot="session-review-v2-empty-visual" aria-hidden="true">
          <span data-slot="session-review-v2-empty-orbit" />
          <Icon name="review" size="large" />
          <span data-slot="session-review-v2-empty-node" data-position="start" />
          <span data-slot="session-review-v2-empty-node" data-position="end" />
        </div>
        <div data-slot="session-review-v2-empty-copy">
          <div data-slot="session-review-v2-empty-changes-title">
            {i18n.t("ui.sessionReviewV2.empty.changes.title")}
          </div>
          <div data-slot="session-review-v2-empty-changes-description">
            {i18n.t("ui.sessionReviewV2.empty.changes.description")}
          </div>
        </div>
      </div>
    </div>
  )
}
