import { useLocale } from "@k2b/ui";
import { type Accessor, createResource, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { readApiError } from "./api-response";
import { mailComposerMessages } from "./mail-composer-messages";

/**
 * The chosen signature as a fixed block after the text (F3): exactly what Mail inserts at send, in the editor's calm
 * style, not editable here. The signature menu in the draft's tools switches it. While a new choice loads, the last
 * text stays, so the block does not jump; if it cannot load, a quiet line says Mail still adds it when sending.
 */
export default function MailInlineSignature(props: {
  mailboxId: string;
  senderIdentityId: Accessor<string>;
  signatureTemplateId: Accessor<string | null>;
  format: Accessor<"plain" | "markdown">;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const source = () => {
    const signatureTemplateId = props.signatureTemplateId();
    if (typeof window === "undefined" || !signatureTemplateId || !props.senderIdentityId()) return false;
    return JSON.stringify({ senderIdentityId: props.senderIdentityId(), signatureTemplateId, format: props.format() });
  };
  const [signature] = createResource(source, async (key) => {
    const response = await apiClient.mailboxes[":mailboxId"]["compose-signature"].$post({
      param: { mailboxId: props.mailboxId },
      json: JSON.parse(key),
    });
    if (!response.ok) throw new Error(await readApiError(response, t().signatureUnavailable));
    return (await response.json()).text;
  });
  return (
    <Show when={props.signatureTemplateId()}>
      <div class="mail-inline-draft-signature" data-mail-draft-signature role="group" aria-label={t().signatureBlock}>
        <Show when={!signature.error} fallback={<span class="mail-inline-draft-signature-note">{t().signatureAtSend}</span>}>
          {signature.latest ?? ""}
        </Show>
      </div>
    </Show>
  );
}
