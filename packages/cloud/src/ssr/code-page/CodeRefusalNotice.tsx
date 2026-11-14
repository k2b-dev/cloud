import { Button, ButtonLink, NoticeCard, toast, useLocale } from "@k2b/ui";
import { createMemo, type JSX, Show } from "solid-js";
import type { CodePageRefusal, CodePageTarget } from "./data";
import { type CodePageMessages, codePageMessages } from "./messages";

/** Copies the service account's handle, which whoever manages a target enters in its access editor. */
export const copyHandle = async (handle: string, t: CodePageMessages) => {
  try {
    await navigator.clipboard.writeText(handle);
    toast.success(t.handleCopied);
  } catch {
    toast.error(t.handleCopyFailed);
  }
};

const REFUSAL_ICON: Record<CodePageRefusal["kind"], string> = {
  target_refused: "ti ti-lock",
  policy: "ti ti-shield-x",
  approval: "ti ti-shield-lock",
};

/**
 * A refused call of a failed run, as cron reports a failed job: what the Code called and where, stated as a fact and
 * never as the run's cause. A foreign target appears only as type and ID, linked where its type's page allows. Readers
 * learn only that a call was refused, because a target ID can come from data at run time. The Code page and
 * Administration › Code show the same notice.
 */
export function CodeRefusalNotice(props: {
  refusal: CodePageRefusal;
  /** The service account the Code runs as, such as "Code of info@example.com"; null for personal Code. */
  account: string | null;
  /** Personal Code shared with the viewer runs as someone else. */
  runsAsOther?: boolean;
  /** The service account's handle, for whoever manages the target; null while it is unknown. */
  handle: string | null;
  /** The viewer may see the Code's calls. */
  editor: boolean;
  /** Cloud admins decide approvals and get the link to the version's review. */
  cloudAdmin: boolean;
  /** Further actions of the surrounding view, such as running the failed run again. */
  children?: JSX.Element;
  actions?: boolean;
}) {
  const locale = useLocale();
  const t = createMemo(() => codePageMessages.resolve([locale()]).t);
  const call = () => props.refusal.call;
  const action = () => call()?.title ?? call()?.capability ?? "";
  const id = (target: CodePageTarget) => (
    <Show when={target.href} fallback={<code>{target.ref.id}</code>}>
      {(href) => (
        <a class="k2b-text-link" href={href()}>
          <code>{target.ref.id}</code>
        </a>
      )}
    </Show>
  );
  const title = (): JSX.Element => {
    if (props.refusal.code === "code_ai_budget_limit") return t().aiBudgetRefused;
    if (props.refusal.code === "code_ai_daily_budget_limit") return t().aiDailyBudgetRefused;
    if (props.refusal.code === "code_ai_owner_daily_budget_limit") return t().aiOwnerDailyBudgetRefused;
    if (props.refusal.kind === "policy") return t().policyRefusedTitle;
    if (props.refusal.kind === "approval") return t().approvalRefusedTitle;
    const current = call();
    if (!current) return t().refusedReaderTitle;
    const target = current.target;
    if (!target) return t().refusedApp({ name: current.capability.split(".")[0]! });
    return (
      <>
        {t().refusedTargetLead({ type: target.typeTitle })}
        {id(target)}.
      </>
    );
  };
  const what = (): JSX.Element => {
    const target = call()!.target;
    if (props.refusal.kind === "target_refused")
      return target ? t().refusedActionThere({ action: action() }) : t().refusedAction({ action: action() });
    return target ? (
      <>
        {t().refusedCallLead({ action: action() })}
        {target.typeTitle ? `${target.typeTitle} ` : ""}
        {id(target)}.
      </>
    ) : (
      t().refusedAction({ action: action() })
    );
  };
  const why = () =>
    props.account ? t().refusedWhyAccount({ name: props.account }) : props.runsAsOther ? t().refusedWhyOwner : t().refusedWhyYou;
  const detail = (): JSX.Element => {
    if (props.refusal.code?.startsWith("code_ai_")) return call() ? what() : null;
    if (!call()) {
      if (props.editor) return t().refusedDetailsFailed;
      return [props.account ? t().refusedReaderAccount({ name: props.account }) : "", t().refusedReaderDetail].filter(Boolean).join(" ");
    }
    return (
      <>
        {what()}{" "}
        {props.refusal.kind === "target_refused"
          ? why()
          : props.refusal.kind === "policy"
            ? t().policyRefusedDetail
            : t().approvalRefusedDetail}
      </>
    );
  };
  /** Only editors see the target, so only they get the handle and the hint for whoever manages it. */
  const targetHint = () => props.refusal.kind === "target_refused" && call() !== null;
  const handle = () => (targetHint() && props.account ? props.handle : null);
  const approvalLink = () =>
    props.refusal.kind === "approval" && call() !== null && props.cloudAdmin
      ? `/admin/code?sec=approvals&id=${encodeURIComponent(props.refusal.versionId)}`
      : null;
  const note = (): JSX.Element | null => {
    if (props.refusal.kind === "approval" && call()) return t().nextRunTries;
    if (!targetHint()) return null;
    if (!props.account) return `${t().refusedNoteYou} ${t().nextRunTries}`;
    const current = handle();
    return current ? (
      <>
        {t().refusedNoteLead}
        <code>{current}</code>
        {t().refusedNoteEnd} {t().nextRunTries}
      </>
    ) : (
      `${t().refusedNoteNoHandle} ${t().nextRunTries}`
    );
  };
  return (
    <div class="cloud-code__refusal">
      <NoticeCard tone="danger" icon={REFUSAL_ICON[props.refusal.kind]} title={title()} detail={detail()} role="alert" />
      <Show when={handle() || approvalLink() || props.actions}>
        <div class="cloud-code__note-actions">
          <Show when={handle()}>
            {(value) => (
              <Button type="button" size="sm" variant="primary" onClick={() => void copyHandle(value(), t())}>
                <i class="ti ti-copy" aria-hidden="true" />
                {t().copyHandle}
              </Button>
            )}
          </Show>
          <Show when={approvalLink()}>
            {(href) => (
              <ButtonLink size="sm" variant="secondary" href={href()}>
                <i class="ti ti-shield-check" aria-hidden="true" />
                {t().viewApproval}
              </ButtonLink>
            )}
          </Show>
          {props.children}
        </div>
      </Show>
      <Show when={note()}>{(text) => <p class="cloud-code__quiet">{text()}</p>}</Show>
    </div>
  );
}
