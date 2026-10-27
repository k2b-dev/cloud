import { query } from "@k2b/stdlib/solid";
import { Button, InlineGuidance, RichSelect, RichSelectFacts, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { SenderIdentity } from "../../contracts";
import { readApiError } from "./api-response";
import { mailComposerMessages } from "./mail-composer-messages";

/** Both compose entry points use the same authorized consequence read and choice presentation. */
export default function MailSenderSelect(props: {
  mailboxId: string;
  identities: readonly Pick<SenderIdentity, "id" | "displayName" | "fromAddress" | "status">[];
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
      if (!response.ok) throw new Error(await readApiError(response, t().identitiesLoadFailed));
      return { mailboxId, items: await response.json() };
    },
  });
  const current = () => (!choices.error() && choices.data()?.mailboxId === props.mailboxId ? choices.data() : undefined);
  const selected = () => props.identities.find((identity) => identity.id === props.value);
  const displayName = (identity: { id: string; displayName?: string; fromAddress: string }) =>
    identity.displayName ?? props.identities.find((local) => local.id === identity.id)?.displayName ?? "";
  const items = () =>
    (current()?.items ?? props.identities).map((identity) => ({
      value: identity.id,
      label: displayName(identity) || identity.fromAddress,
      description: displayName(identity) ? identity.fromAddress : undefined,
      disabledReason: identity.status !== "verified" ? t().senderNotVerified : undefined,
    }));
  return (
    <>
      <RichSelect
        label={props.appearance === "plain" ? undefined : t().from}
        aria-label={t().chooseSender}
        title={t().chooseSender}
        value={props.value}
        onValueChange={(id) => {
          if (id) props.onChange(id);
        }}
        triggerLabel={selected() ? [displayName(selected()!), selected()!.fromAddress].filter(Boolean).join(" · ") : undefined}
        placeholder={t().chooseSender}
        items={items()}
        status={items().length ? "ready" : choices.loading() ? "loading" : choices.error() ? "error" : "ready"}
        onRetry={() => void choices.refresh()}
        empty={t().noSenders}
        disabled={props.disabled || !props.mailboxId}
        appearance={props.appearance}
        renderPreview={(item) => {
          const choice = current()?.items.find((choice) => choice.id === item.value);
          if (!choice || item.disabledReason)
            return (
              <p>
                {item.disabledReason ?? (choices.loading() || choices.refreshing() ? t().senderPreviewLoading : t().senderPreviewUnknown)}
              </p>
            );
          const audience = choice.audience;
          const visibility = !audience
            ? undefined
            : audience.public
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
                ...(audience
                  ? [
                      {
                        icon: "ti ti-eye",
                        text: [
                          visibility,
                          ...(audience.serviceAccountCount ? [t().senderAccounts({ count: audience.serviceAccountCount })] : []),
                          ...(choice.assignedReaders ? [t().senderAssignedReaders] : []),
                        ].join(" "),
                      },
                    ]
                  : []),
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
      <Show when={choices.error()}>
        <InlineGuidance tone="warning">
          {t().senderPreviewUnknown}{" "}
          <Button size="xs" variant="text" onClick={() => void choices.refresh()}>
            {t().retry}
          </Button>
        </InlineGuidance>
      </Show>
    </>
  );
}
