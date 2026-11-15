import { Button, ButtonLink, ChangeList, NoticeCard, StatusBadge } from "@k2b/ui";
import { type JSX, Show } from "solid-js";
import { openPanel } from "../../browser/panel";
import type { CodeVersionReadModel } from "../../contracts/code-read-model";
import { switchOnReady } from "./CodeActivation";
import type { CodePageData, CodePageReady, CodePageVersion } from "./data";
import { type PageText, personal, withQuery } from "./page-kit";

/**
 * The short approval card for a version that waits: ready to switch on, waiting for an administrator, changes
 * requested, or rejected. Its content comes from the version's read model, so it never shows code or identifiers.
 *
 * It keeps today's presentation (`NoticeCard` and buttons) behind one component, so the lead can move it onto the shared
 * `ApprovalFrame` from the capability blocks without touching the page around it.
 */
export function CodeVersionApproval(props: {
  data: CodePageData;
  state: CodePageReady;
  version: CodePageVersion;
  words: CodeVersionReadModel | null;
  text: PageText;
  onActivate: () => void;
  /** On the versions tab the card is already beside everything; it offers no "See everything". */
  onPage?: boolean;
}): JSX.Element {
  const t = props.text.t;
  const editor = () => props.state.permission === "editor";
  const running = () => props.state.active?.number ?? null;
  const ready = () => props.version.status === "submitted" || props.version.status === "approved";
  const kind = () =>
    props.version.status === "pending"
      ? ("waiting" as const)
      : props.version.status === "changes_requested"
        ? ("changes" as const)
        : props.version.status === "rejected"
          ? ("rejected" as const)
          : ("ready" as const);
  const title = () => {
    const version = props.version.number;
    switch (kind()) {
      case "waiting":
        return t().approvalWaiting({ version });
      case "changes":
        return t().approvalChanges({ version });
      case "rejected":
        return t().approvalRejected({ version });
      default:
        return personal(props.data) ? t().approvalReadyPersonal({ version }) : t().approvalReady({ version, name: props.data.owner.title });
    }
  };
  const detail = () => {
    const decidedBy = props.version.decidedBy?.name ?? null;
    switch (kind()) {
      case "waiting":
        return `${t().approvalAdminWhy} ${t().approvalAdminNext} ${t().approvalKeep({ running: running() })}`;
      case "changes":
        return `${t().approvalReviewed({ name: decidedBy })} ${t().approvalKeepNow({ running: running() })}`;
      case "rejected":
        return `${t().approvalRejectedBy({ name: decidedBy })} ${t().approvalKeepNow({ running: running() })}`;
      default:
        return t().approvalKeep({ running: running() });
    }
  };
  const tone = () => (kind() === "rejected" ? "danger" : kind() === "ready" ? "info" : "warning");
  const icon = () =>
    kind() === "waiting"
      ? "ti ti-hourglass"
      : kind() === "changes"
        ? "ti ti-message-2"
        : kind() === "rejected"
          ? "ti ti-circle-x"
          : "ti ti-shield-check";
  const changed = () => (props.words?.changes.rows.items ?? []).filter((row) => row.kind !== "same");
  const same = () =>
    (props.words?.changes.rows.items ?? []).filter((row) => row.kind === "same").length + (props.words?.changes.rows.more ?? 0);
  const examples = () => props.words?.examples ?? null;
  const phone = () => !props.data.activation.allowed && props.data.activation.reason === "phone";
  const canSwitchOn = () => ready() && switchOnReady(props.state) && props.state.waiting?.id === props.version.id;
  const panel = () => (editor() ? props.data.editor : null);
  const actions = () => (
    <>
      <Show when={!props.onPage}>
        <ButtonLink size="sm" variant="secondary" href={withQuery(props.data.href, { tab: "versions", version: props.version.id })}>
          {t().seeAll}
        </ButtonLink>
      </Show>
      <Show when={kind() === "ready" && canSwitchOn()}>
        <Button type="button" size="sm" variant="primary" disabled={phone()} onClick={() => props.onActivate()}>
          <i class="ti ti-power" aria-hidden="true" />
          {t().switchOnVersion({ version: props.version.number })}
        </Button>
      </Show>
      <Show when={kind() === "changes" && panel()}>
        {(editorPanel) => (
          <Button type="button" size="sm" variant="primary" onClick={() => openPanel(editorPanel().provider)}>
            <i class={editorPanel().icon} aria-hidden="true" />
            {t().reworkWith({ name: editorPanel().label })}
          </Button>
        )}
      </Show>
      <Show when={kind() === "rejected" && panel()}>
        {(editorPanel) => (
          <Button type="button" size="sm" variant="secondary" onClick={() => openPanel(editorPanel().provider)}>
            <i class={editorPanel().icon} aria-hidden="true" />
            {t().rebuildWith({ name: editorPanel().label })}
          </Button>
        )}
      </Show>
    </>
  );
  return (
    <NoticeCard
      tone={tone()}
      icon={icon()}
      layout="card"
      class="cloud-code__approval"
      data-version={props.version.number}
      title={title()}
      detail={detail()}
      actions={actions()}
    >
      <Show when={(kind() === "changes" || kind() === "rejected") && props.version.decisionComment}>
        {(comment) => (
          <div class="cloud-code__approval-message">
            <span class="cloud-code__approval-from">
              {kind() === "changes"
                ? t().messageFrom({ name: props.version.decidedBy?.name ?? null })
                : t().reasonFrom({ name: props.version.decidedBy?.name ?? null })}
            </span>
            <p>{comment()}</p>
          </div>
        )}
      </Show>
      <Show when={kind() !== "rejected" && changed().length > 0}>
        <ChangeList
          class="cloud-code__approval-changes"
          label={t().changesTitle}
          items={[
            ...changed().map((row) => ({
              tone: row.kind === "remove" ? ("remove" as const) : ("add" as const),
              content: row.text,
              detail: row.note,
            })),
            ...(same() > 0 ? [{ tone: "neutral" as const, icon: "ti ti-equal", content: t().sameRows({ count: same() }) }] : []),
          ]}
        />
      </Show>
      <Show when={kind() !== "rejected" && changed().length === 0 && props.words}>
        {(words) => (
          <ChangeList
            class="cloud-code__approval-changes"
            label={t().changesTitle}
            items={[{ tone: "neutral" as const, icon: "ti ti-equal", content: words().changes.text }]}
          />
        )}
      </Show>
      <Show when={kind() === "ready" || kind() === "waiting"}>
        <p class="cloud-code__approval-foot">
          <Show when={examples()}>
            {(current) => (
              <StatusBadge
                variant="text"
                tone={current().state === "passed" ? "ok" : current().state === "failed" ? "error" : "warning"}
                icon={
                  current().state === "passed"
                    ? "ti ti-circle-check"
                    : current().state === "failed"
                      ? "ti ti-circle-x"
                      : "ti ti-alert-triangle"
                }
                label={current().summary}
              />
            )}
          </Show>
          <Show when={kind() === "ready" && phone()}>
            <StatusBadge variant="text" tone="warning" icon="ti ti-device-mobile-off" label={t().phoneShort} />
          </Show>
        </p>
      </Show>
      <Show when={kind() === "changes" && panel()}>
        <p class="cloud-code__approval-foot">{t().reworkNote}</p>
      </Show>
    </NoticeCard>
  );
}
