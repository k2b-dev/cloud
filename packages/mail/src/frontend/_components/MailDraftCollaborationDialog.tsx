import { type DateContext, dates } from "@k2b/stdlib";
import { Avatar, Button, prompts, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { DraftLease, DraftLeaseHolder } from "../../contracts";
import { mailComposerMessages } from "./mail-composer-messages";
import type { MailDraftLeaseConflict } from "./mail-draft-session";

export type MailDraftCollaborationChoice = "readonly" | "takeover";
export type MailDraftActorRef = Pick<DraftLeaseHolder, "kind" | "id">;

const isSameActor = (lease: DraftLease | null, currentActor: MailDraftActorRef): boolean =>
  lease?.holder.kind === currentActor.kind && lease.holder.id === currentActor.id;

const avatarSource = (lease: DraftLease | null): string | undefined =>
  lease?.holder.kind === "user" && lease.holder.avatarHash
    ? `/api/accounts/users/${encodeURIComponent(lease.holder.id)}/avatar?rev=${encodeURIComponent(lease.holder.avatarHash)}`
    : undefined;

export const mailDraftCollaborationCopy = (conflict: MailDraftLeaseConflict, currentActor: MailDraftActorRef, requestedLocale = "en") => {
  const t = mailComposerMessages.resolve([requestedLocale]).t;
  if (isSameActor(conflict.lease, currentActor)) {
    return {
      title: t.draftOpenAnotherTab,
      description: conflict.reason === "lost" ? t.sameActorLostDescription : t.sameActorHeldDescription,
      status: t.sameActorStatus,
      takeoverLabel: t.editInThisTab,
    };
  }
  if (conflict.lease) {
    const name = conflict.lease.holder.displayName.trim() || t.anotherCollaborator;
    return {
      title: t.collaboratorTitle({ name }),
      description: t.collaboratorDescription,
      status: t.collaboratorStatus({ name }),
      takeoverLabel: t.takeOver,
    };
  }
  return {
    title: t.draftOpenElsewhere,
    description: t.unknownSessionDescription,
    status: t.unknownSessionStatus,
    takeoverLabel: t.tryEditingHere,
  };
};

export function MailDraftCollaborationDialog(props: {
  conflict: MailDraftLeaseConflict;
  currentActor: MailDraftActorRef;
  dateConfig: DateContext;
  close: (choice: MailDraftCollaborationChoice) => void;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const copy = () => mailDraftCollaborationCopy(props.conflict, props.currentActor, locale());
  const lease = () => props.conflict.lease;

  return (
    <div class="flex min-w-0 flex-col gap-4">
      <p class="text-sm leading-6 text-secondary">{copy().description}</p>
      <Show when={lease()}>
        {(current) => (
          <div class="flex min-w-0 items-center gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3">
            <Avatar name={current().holder.displayName} src={avatarSource(current())} size="sm" loading="eager" />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-primary">{current().holder.displayName || t().anotherCollaborator}</p>
              <p class="text-xs leading-5 text-dimmed">
                {t().opened}{" "}
                <time dateTime={current().acquiredAt}>{dates.formatDateTimeRelative(current().acquiredAt, props.dateConfig)}</time>
                {" · "}
                {t().reservedUntil}{" "}
                <time dateTime={current().expiresAt}>{dates.formatDateTime(current().expiresAt, props.dateConfig)}</time>
              </p>
            </div>
          </div>
        )}
      </Show>
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" type="button" onClick={() => props.close("readonly")}>
          {t().viewReadOnly}
        </Button>
        <Button type="button" onClick={() => props.close("takeover")}>
          {copy().takeoverLabel}
        </Button>
      </div>
    </div>
  );
}

export const openMailDraftCollaborationDialog = (options: {
  conflict: MailDraftLeaseConflict;
  currentActor: MailDraftActorRef;
  dateConfig: DateContext;
  locale?: string;
}): Promise<MailDraftCollaborationChoice | undefined> => {
  const copy = mailDraftCollaborationCopy(options.conflict, options.currentActor, options.locale);
  return prompts.dialog<MailDraftCollaborationChoice>((close) => <MailDraftCollaborationDialog {...options} close={close} />, {
    title: copy.title,
    icon: "ti ti-users",
    size: "small",
  });
};
