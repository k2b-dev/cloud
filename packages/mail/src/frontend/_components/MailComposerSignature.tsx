import { SelectChip, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import { mailComposerMessages } from "./mail-composer-messages";
import { type MailComposerSignatures, signatureOptions } from "./mail-composer-signature";

/** The signature choice below the text: Mail adds the chosen signature after the body when it renders the message. */
export default function MailComposerSignature(props: {
  signatures: MailComposerSignatures;
  value: string | null;
  senderDefaultId: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const options = createMemo(() =>
    signatureOptions(props.signatures, props.value, props.senderDefaultId, {
      none: t().noSignature,
      default: t().defaultSignature,
      unavailable: t().unavailableSignature,
    }),
  );
  const selectedLabel = () => options().find((option) => option.value === (props.value ?? ""))?.label ?? t().noSignature;
  return (
    <div class="mail-composer-signature flex min-w-0 shrink-0 items-center gap-2 pb-1 text-sm">
      <span class="shrink-0 text-dimmed">{t().signature}</span>
      <SelectChip
        class="min-w-0"
        value={() => props.value ?? ""}
        options={options()}
        icon="ti ti-signature"
        aria-label={t().chooseSignature({ name: selectedLabel() })}
        disabled={props.disabled}
        position="top-left"
        onValueChange={(value) => props.onChange(value || null)}
      />
    </div>
  );
}
