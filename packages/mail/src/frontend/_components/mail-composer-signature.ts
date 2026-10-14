import type { SelectChipOption } from "@k2b/ui";
import type { SenderIdentity } from "../../contracts";

export type MailComposerSignatures = {
  templates: Array<{ id: string; name: string }>;
  personalDefaults: Array<{ senderIdentityId: string; templateId: string }>;
};

export const defaultSignatureTemplateId = (
  signatures: MailComposerSignatures,
  identities: Pick<SenderIdentity, "id" | "defaultSignatureTemplateId">[],
  senderIdentityId: string,
): string | null => {
  const personal = signatures.personalDefaults.find((entry) => entry.senderIdentityId === senderIdentityId)?.templateId;
  const mailbox = identities.find((identity) => identity.id === senderIdentityId)?.defaultSignatureTemplateId;
  return [personal, mailbox].find((id) => id && signatures.templates.some((template) => template.id === id)) ?? null;
};

export const signatureOptions = (
  signatures: MailComposerSignatures,
  currentId: string | null,
  senderDefaultId: string | null,
  labels: { none: string; default: string; unavailable: string },
): SelectChipOption<string>[] => {
  const options: SelectChipOption<string>[] = [
    { value: "", label: labels.none },
    ...signatures.templates.map((template) => ({
      value: template.id,
      label: template.name,
      ...(template.id === senderDefaultId ? { description: labels.default } : {}),
    })),
  ];
  if (currentId && !signatures.templates.some((template) => template.id === currentId))
    options.push({ value: currentId, label: labels.unavailable });
  return options;
};
