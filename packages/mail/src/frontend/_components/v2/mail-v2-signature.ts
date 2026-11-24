import { apiClient } from "../../../api/client";
import type { SenderIdentity } from "../../../contracts";
import { defaultSignatureTemplateId } from "../mail-composer-signature";

type SignatureChoices = Parameters<typeof defaultSignatureTemplateId>[0];

// One mailbox's signature choices, read once per page: the resting reply of every conversation shows its sender's.
const choices = new Map<string, Promise<SignatureChoices>>();
const loadChoices = (mailboxId: string): Promise<SignatureChoices> => {
  const cached = choices.get(mailboxId);
  if (cached) return cached;
  const loading = (async () => {
    const param = { mailboxId };
    const [templatesResponse, defaultsResponse] = await Promise.all([
      apiClient.mailboxes[":mailboxId"]["compose-templates"].$get({ param }),
      apiClient.mailboxes[":mailboxId"]["compose-signature-defaults"].$get({ param }),
    ]);
    const templates = templatesResponse.ok ? await templatesResponse.json() : [];
    const defaults = defaultsResponse.ok ? await defaultsResponse.json() : [];
    // The same choices as Mail's reply box (MailReplyBox): signatures, and the person's own defaults per sender.
    return {
      templates: templates.filter((template) => template.kind === "signature").map(({ id, name }) => ({ id, name })),
      personalDefaults: defaults
        .filter((entry) => entry.userId !== null)
        .map(({ senderIdentityId, templateId }) => ({ senderIdentityId, templateId })),
    };
  })();
  choices.set(mailboxId, loading);
  loading.catch(() => choices.delete(mailboxId));
  return loading;
};

/**
 * The text of the signature a reply from `sender` starts with, as the server renders it for a plain draft; null without
 * one. The resting reply shows it quietly; a signature that cannot load is left out, and the reply box still adds it.
 */
export const loadMailV2Signature = async (
  mailboxId: string,
  identities: Pick<SenderIdentity, "id" | "defaultSignatureTemplateId">[],
  senderIdentityId: string,
): Promise<string | null> => {
  const signatureTemplateId = defaultSignatureTemplateId(await loadChoices(mailboxId), identities, senderIdentityId);
  if (!signatureTemplateId) return null;
  const response = await apiClient.mailboxes[":mailboxId"]["compose-signature"].$post({
    param: { mailboxId },
    json: { senderIdentityId, signatureTemplateId, format: "plain" },
  });
  if (!response.ok) return null;
  const { text } = await response.json();
  return text.trim() || null;
};
