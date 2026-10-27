import { query } from "@k2b/stdlib/solid";
import { RichSelect, RichSelectFacts, useLocale } from "@k2b/ui";
import { apiClient } from "../../api/client";
import type { SenderIdentity } from "../../contracts";
import { readApiError } from "./api-response";
import { mailComposerMessages } from "./mail-composer-messages";

/** Both compose entry points use the same authorized consequence read and choice presentation. */
export default function MailSenderSelect(props: {
  mailboxId: string;
  identities: readonly SenderIdentity[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Recipient defaults apply only when creating a draft, never when switching an existing draft. */
  showRecipientDefaults?: boolean;
  appearance?: "plain" | "field";
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const choices = query.create({
    source: () => props.mailboxId,
    enabled: () => Boolean(props.mailboxId),
    load: async (mailboxId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["sender-choices"].$get(
        { param: { mailboxId } },
        { init: { signal: abortSignal } },
      );
      if (response.status === 403) return { mailboxId, denied: true, items: [] };
      if (!response.ok) throw new Error(await readApiError(response, t().identitiesLoadFailed));
      return { mailboxId, denied: false, items: await response.json() };
    },
  });
  const current = () => (choices.data()?.mailboxId === props.mailboxId ? choices.data() : undefined);
  const selected = () => props.identities.find((identity) => identity.id === props.value);
  const items = () =>
    current()?.denied
      ? props.identities.map((identity) => ({ value: identity.id, label: identity.label, disabledReason: t().senderNoWrite }))
      : (current()?.items ?? []).map((choice) => ({
          value: choice.id,
          label: choice.label,
          description: choice.fromAddress,
          disabledReason: choice.status !== "verified" ? t().senderNotVerified : undefined,
        }));
  return (
    <RichSelect
      label={props.appearance === "plain" ? undefined : t().from}
      aria-label={t().chooseSender}
      title={t().chooseSender}
      value={props.value}
      onValueChange={(id) => {
        if (id) props.onChange(id);
      }}
      triggerLabel={selected() ? `${selected()!.label} · ${selected()!.fromAddress}` : undefined}
      placeholder={t().chooseSender}
      items={items()}
      status={choices.loading() || choices.refreshing() ? "loading" : choices.error() ? "error" : "ready"}
      onRetry={() => void choices.refresh()}
      empty={current()?.denied ? t().senderNoWrite : t().noSenders}
      disabled={props.disabled || !props.mailboxId}
      appearance={props.appearance}
      renderPreview={(item) => {
        const choice = current()?.items.find((choice) => choice.id === item.value);
        if (!choice || item.disabledReason) return <p>{item.disabledReason}</p>;
        const audience = choice.audience;
        const visibility = audience.public
          ? t().senderPublic
          : audience.authenticated
            ? t().senderAuthenticated
            : t().senderMembers({ count: audience.memberCount });
        const replies = [
          t().senderReplies({ address: choice.replyTo }),
          ...(props.showRecipientDefaults && choice.defaultCc.length
            ? [t().senderCc({ addresses: choice.defaultCc.map((address) => address.address).join(", ") })]
            : []),
          ...(props.showRecipientDefaults && choice.defaultBcc.length
            ? [t().senderBcc({ addresses: choice.defaultBcc.map((address) => address.address).join(", ") })]
            : []),
        ];
        return (
          <RichSelectFacts
            facts={[
              {
                icon: "ti ti-eye",
                text: [
                  visibility,
                  ...(audience.serviceAccountCount ? [t().senderAccounts({ count: audience.serviceAccountCount })] : []),
                  ...(choice.assignedReaders ? [t().senderAssignedReaders] : []),
                ].join(" "),
              },
              { icon: "ti ti-arrow-back", text: replies.join(" ") },
              {
                icon: "ti ti-signature",
                text: choice.signatureName ? t().senderSignature({ name: choice.signatureName }) : t().senderNoSignature,
              },
            ]}
          />
        );
      }}
    />
  );
}
