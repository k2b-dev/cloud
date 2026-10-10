import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import type { SenderIdentity } from "../../contracts";
import { blockedSenderIdentity, mailSenderIdentityStatusMessages, senderIdentityReasonCopy } from "./mail-sender-identity-status";

/**
 * Explains why a mailbox without a verified sender cannot send, with the reason Mail reports for its sender
 * identity, and leads mailbox admins to the setting that fixes it.
 */
export default function MailSenderUnavailableNotice(props: {
  identities: readonly SenderIdentity[];
  /** Opens the mailbox's sender settings; absent when the person cannot manage the mailbox. */
  onOpenSettings?: () => void;
  opening?: boolean;
  class?: string;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailSenderIdentityStatusMessages.resolve([locale()]).t);
  const detail = createMemo(() => {
    const identity = blockedSenderIdentity(props.identities);
    if (!identity?.statusReason) return t().noIdentity;
    const copy = senderIdentityReasonCopy(identity.statusReason, locale());
    return `${t().identityReason({ label: identity.label, reason: copy.label })} ${copy.hint}`;
  });
  return (
    <NoticeCard tone="warning" role="status" class={props.class} title={t().cannotSend} detail={detail()} data-mail-sender-unavailable>
      <Show when={props.onOpenSettings} fallback={<span class="text-dimmed">{t().askAdmin}</span>}>
        {(open) => (
          <Button variant="secondary" size="sm" type="button" disabled={props.opening} onClick={() => open()()}>
            <i class={props.opening ? "ti ti-loader-2 animate-spin" : "ti ti-settings"} aria-hidden="true" />
            {t().openSenderSettings}
          </Button>
        )}
      </Show>
    </NoticeCard>
  );
}
