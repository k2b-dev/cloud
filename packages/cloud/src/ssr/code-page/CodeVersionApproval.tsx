import { ChangeList, Chat, type ChatDecisionAnswer, type ChatDecisionFact, type ChatOutcomeTone } from "@k2b/ui";
import { type JSX, Show } from "solid-js";
import type { ActionText } from "../../ai/chat/action-card";
import { actionMessages } from "../../ai/chat/action-messages";
import { ApprovalFrame, type ApprovalFrameStatus } from "../../approvals/ApprovalFrame";
import { openPanel } from "../../browser/panel";
import type { CodeVersionReadModel } from "../../contracts/code-read-model";
import { switchOnReady } from "./CodeActivation";
import type { CodePageData, CodePageReady, CodePageVersion } from "./data";
import { type PageText, personal, withQuery } from "./page-kit";

type Kind = "ready" | "waiting" | "changes" | "rejected";

/**
 * The approval of a version that waits, drawn by the shared `ApprovalFrame` (v12 3g): open while it is ready to switch
 * on; in its short form while it waits for an administrator, needs changes, or was rejected. Its words come from the
 * version's read model, so it never shows code or identifiers.
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
  const kind = (): Kind =>
    props.version.status === "pending"
      ? "waiting"
      : props.version.status === "changes_requested"
        ? "changes"
        : props.version.status === "rejected"
          ? "rejected"
          : "ready";
  const decidedBy = () => props.version.decidedBy?.name ?? null;
  const phone = () => !props.data.activation.allowed && props.data.activation.reason === "phone";
  const canSwitchOn = () => switchOnReady(props.state) && props.state.waiting?.id === props.version.id;
  const panel = () => (editor() ? props.data.editor : null);
  const sentence = (): ActionText => {
    const version = {
      kind: "chip" as const,
      chip: { kind: "object" as const, title: t().versionLine({ version: props.version.number }) },
    };
    return personal(props.data)
      ? [{ kind: "text", text: t().askBefore }, version, { kind: "text", text: t().askAfter }]
      : [
          { kind: "text", text: t().askBefore },
          version,
          { kind: "text", text: t().askMiddle },
          { kind: "chip", chip: { kind: "place", title: props.data.owner.title } },
          { kind: "text", text: t().askAfter },
        ];
  };
  const changed = () => (props.words?.changes.rows.items ?? []).filter((row) => row.kind !== "same");
  const same = () =>
    (props.words?.changes.rows.items ?? []).filter((row) => row.kind === "same").length + (props.words?.changes.rows.more ?? 0);
  const changes = () => (
    <ChangeList
      label={t().changesTitle}
      items={
        changed().length > 0
          ? [
              ...changed().map((row) => ({
                tone: row.kind === "remove" ? ("remove" as const) : ("add" as const),
                content: row.text,
                detail: row.note,
              })),
              ...(same() > 0 ? [{ tone: "neutral" as const, icon: "ti ti-equal", content: t().sameRows({ count: same() }) }] : []),
            ]
          : [{ tone: "neutral" as const, icon: "ti ti-equal", content: props.words?.changes.text ?? "" }]
      }
    />
  );
  const facts = (): ChatDecisionFact[] => {
    const examples = props.words?.examples;
    return [
      ...(examples
        ? [
            {
              text: examples.summary,
              icon:
                examples.state === "passed"
                  ? "ti ti-circle-check"
                  : examples.state === "failed"
                    ? "ti ti-circle-x"
                    : "ti ti-alert-triangle",
              tone:
                examples.state === "passed"
                  ? ("success" as const)
                  : examples.state === "failed"
                    ? ("danger" as const)
                    : ("warning" as const),
            },
          ]
        : []),
      { text: t().approvalKeep({ running: running() }), icon: "ti ti-history" },
    ];
  };
  const switchOn = (): ChatDecisionAnswer | undefined =>
    canSwitchOn()
      ? { label: t().switchOnVersion({ version: props.version.number }), icon: "ti ti-power", onSelect: () => props.onActivate() }
      : undefined;
  const status = (): ApprovalFrameStatus | undefined =>
    kind() === "waiting"
      ? { tone: "waiting", label: t().vWaiting }
      : kind() === "changes"
        ? { tone: "warning", label: t().vChanges }
        : kind() === "rejected"
          ? { tone: "error", label: t().vRejected }
          : undefined;
  const outcomeTone = (): ChatOutcomeTone => (kind() === "rejected" ? "error" : kind() === "changes" ? "warning" : "waiting");
  const outcomeText = () =>
    kind() === "waiting"
      ? t().approvalWaiting({ version: props.version.number })
      : kind() === "changes"
        ? t().approvalChanges({ version: props.version.number })
        : t().approvalRejected({ version: props.version.number });
  const outcomeDetail = () => {
    const comment = props.version.decisionComment;
    const lead =
      kind() === "waiting"
        ? `${t().approvalAdminWhy} ${t().approvalAdminNext} ${t().approvalKeep({ running: running() })}`
        : kind() === "changes"
          ? `${t().approvalReviewed({ name: decidedBy() })} ${t().approvalKeepNow({ running: running() })}`
          : `${t().approvalRejectedBy({ name: decidedBy() })} ${t().approvalKeepNow({ running: running() })}`;
    return (
      <>
        {lead}
        <Show when={kind() !== "waiting" && comment}>
          {(text) => (
            <span class="cloud-code__approval-message">
              <span class="cloud-code__approval-from">
                {kind() === "changes" ? t().messageFrom({ name: decidedBy() }) : t().reasonFrom({ name: decidedBy() })}
              </span>
              {text()}
            </span>
          )}
        </Show>
      </>
    );
  };
  const outcomeActions = () => (
    <>
      <Show when={!props.onPage}>
        <a class="link" href={withQuery(props.data.href, { tab: "versions", version: props.version.id })}>
          {t().seeAll}
        </a>
      </Show>
      <Show when={kind() !== "waiting" && panel()}>
        {(editorPanel) => (
          <button type="button" class="link" onClick={() => openPanel(editorPanel().provider)}>
            {kind() === "changes" ? t().reworkWith({ name: editorPanel().label }) : t().rebuildWith({ name: editorPanel().label })}
          </button>
        )}
      </Show>
    </>
  );
  return (
    <div class="cloud-code__approval" data-version={props.version.number}>
      <ApprovalFrame
        locale={props.text.locale()}
        state={kind() === "ready" ? "open" : "decided"}
        source={{ name: t().approvalSource, icon: "ti ti-code" }}
        status={status()}
        sentence={sentence()}
        reason={{ text: props.words?.changes.text ?? t().approvalKeep({ running: running() }), icon: "ti ti-eye" }}
        details={{
          // As every approval: "Details from Code", then what it is compared with; under it what Cloud vouches for.
          label:
            running() !== null && props.words?.changes.state !== "first"
              ? `${actionMessages(props.text.locale()).detailsFrom({ app: t().approvalSource })} · ${t().changedAgainst({ version: running()! })}`
              : actionMessages(props.text.locale()).detailsFrom({ app: t().approvalSource }),
          content: changes(),
          ...(props.words ? { note: { text: props.words.changes.assurance, icon: "ti ti-info-circle" } } : {}),
        }}
        meta={facts()}
        confirm={phone() ? undefined : switchOn()}
        unavailable={phone() && canSwitchOn() ? { text: t().phoneShort, icon: "ti ti-device-mobile-off", tone: "warning" } : undefined}
        link={
          props.onPage ? undefined : { label: t().seeAll, href: withQuery(props.data.href, { tab: "versions", version: props.version.id }) }
        }
        outcome={
          <Chat.Outcome
            current="state"
            lines={{ state: { tone: outcomeTone(), text: outcomeText(), detail: outcomeDetail(), actions: outcomeActions() } }}
          />
        }
      />
    </div>
  );
}
