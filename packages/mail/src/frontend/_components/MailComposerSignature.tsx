import { Dropdown, type DropdownItem, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import { mailComposerMessages } from "./mail-composer-messages";
import { type MailComposerSignatures, signatureOptions } from "./mail-composer-signature";

/** The signature choice in the compose action bar: Mail adds the chosen signature after the body when it renders the message. */
export default function MailComposerSignature(props: {
  signatures: MailComposerSignatures;
  value: string | null;
  senderDefaultId: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const items = createMemo<DropdownItem[]>(() =>
    signatureOptions(props.signatures, props.value, props.senderDefaultId, {
      none: t().noSignature,
      default: t().defaultSignature,
      unavailable: t().unavailableSignature,
    }).map((option) => ({
      label: option.label,
      description: option.description,
      choice: "radio",
      checked: () => option.value === (props.value ?? ""),
      action: () => props.onChange(option.value || null),
    })),
  );
  const buttonLabel = () =>
    props.value
      ? (props.signatures.templates.find((template) => template.id === props.value)?.name ?? t().unavailableSignature)
      : t().noSignatureShort;
  return (
    <Dropdown.Root position="top-right" items={items()} disabled={props.disabled}>
      <Dropdown.Trigger
        size="sm"
        variant="secondary"
        class="mail-composer-signature min-w-0"
        label={t().chooseSignature({ name: buttonLabel() })}
        tooltip={t().chooseSignature({ name: buttonLabel() })}
        disabled={props.disabled}
      >
        <i class="ti ti-signature" aria-hidden="true" />
        {/* The name needs more room than the labels of its neighbors, so it appears one breakpoint later. */}
        <span class="hidden max-w-40 truncate md:inline">{buttonLabel()}</span>
        <i class="ti ti-chevron-down hidden text-xs text-dimmed md:inline" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
