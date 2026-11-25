import { useLocale } from "@k2b/ui";
import type { ActionCard } from "../ai/chat/action-card";
import type { ApprovalDecisionInput, PendingApproval } from "../contracts/approvals";
import { ApprovalCard } from "./ApprovalCard";
import { type ApprovalFailure, type ApprovalOutcome, READER_TIME_ZONE } from "./approval-list";
import { approvalMessages } from "./messages";

export const useApprovalMessages = () => {
  const locale = useLocale();
  return () => approvalMessages.resolve([locale()]).t;
};

type Words = ReturnType<typeof approvalMessages.resolve>["t"];

/** Where a request comes from, in words: the chat or Code version it waits in. The automation that started it comes first. */
export const approvalOrigin = (item: PendingApproval, t: Words): string =>
  item.requester.kind === "code_version"
    ? item.requester.title
      ? t.fromCode({ title: item.requester.title })
      : t.fromUntitledCode
    : item.requester.automation
      ? item.requester.title
        ? t.inChat({ title: item.requester.title })
        : t.inUntitledChat
      : item.requester.title
        ? t.fromChat({ title: item.requester.title })
        : t.fromUntitledChat;

/** The outcome lines a request on this page can reach; the chat it came from shows how the Action itself ends. */
const outcomeLines = (
  card: ActionCard,
  words: Words,
  reopen: () => void,
  retry: () => void,
  codeVersion: boolean,
  reauthenticate: boolean,
) => ({
  sending: { tone: "running" as const, text: [{ kind: "text" as const, text: words.sending }], detail: words.savingDecision },
  approved: {
    tone: "done" as const,
    text: [{ kind: "text" as const, text: words.approvedHere }],
    detail: codeVersion ? words.versionApproved : words.continuesInChat,
  },
  rejected: { tone: "off" as const, text: card.forms.rejected, detail: words.declinedHere },
  elsewhere: { tone: "off" as const, icon: "ti ti-info-circle", text: [{ kind: "text" as const, text: words.decidedElsewhere }] },
  gone: { tone: "off" as const, icon: "ti ti-clock-x", text: [{ kind: "text" as const, text: words.gone }] },
  busy: {
    tone: "warning" as const,
    icon: "ti ti-alert-triangle",
    text: [{ kind: "text" as const, text: words.decisionBusy }],
    detail: words.notApplied,
    action: { label: words.retry, onSelect: retry },
  },
  failed: {
    tone: "warning" as const,
    icon: "ti ti-alert-triangle",
    text: [{ kind: "text" as const, text: words.notApplied }],
    detail: reauthenticate ? words.signInAgain : words.decisionFailed,
    action: { label: words.answerAgain, onSelect: reopen },
  },
});

export type ApprovalEntryProps = {
  item: PendingApproval;
  editDraft?: (values: Record<string, string>) => Promise<boolean>;
  outcome?: ApprovalOutcome;
  busy: boolean;
  failed: ApprovalFailure | false;
  decide: (input: ApprovalDecisionInput) => void;
  reopen: () => void;
  retry: () => void;
};

/** The card of one listed request: the same answers, outcomes and draft editing in both looks of the list. */
export function ApprovalEntry(props: ApprovalEntryProps & { card: ActionCard }) {
  const t = useApprovalMessages();
  const current = () => props.outcome ?? (props.failed === "busy" ? "busy" : props.failed ? "failed" : "sending");
  const state = () => (props.outcome || props.busy || props.failed ? "decided" : "open");
  // `confirm` asks every time, whatever the stored options say.
  const remember = () =>
    props.item.remember.chat && props.item.assurance === "standard"
      ? { website: Boolean(props.item.remember.website), onSelect: () => props.decide({ approved: true, remember: "chat" }) }
      : undefined;
  return (
    <ApprovalCard
      card={props.card}
      state={state()}
      timeZone={READER_TIME_ZONE}
      remember={remember()}
      expiresAt={props.item.expiresAt}
      onEditDraft={props.item.requester.kind === "code_version" ? undefined : props.editDraft}
      unavailable={props.item.canApprove === false ? t().anotherAdminRequired : undefined}
      onConfirm={() => props.decide({ approved: true })}
      onDecline={() => props.decide({ approved: false })}
      // The outcome lines join the card's sentence, so they speak the card's language, the reader's.
      outcome={{
        lines: outcomeLines(
          props.card,
          approvalMessages.resolve([props.card.locale]).t,
          props.reopen,
          props.retry,
          props.item.requester.kind === "code_version",
          props.failed === "reauthenticate",
        ),
        current: current(),
      }}
    />
  );
}
