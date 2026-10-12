import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, toast } from "@k2b/ui";
import { type Accessor, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailContactDirectory } from "../../contact-directory-settings";
import type { Mailbox } from "../../contracts";
import type { mailOverviewMessages } from "../mail-overview-messages";
import { readApiError } from "./api-response";

type SettingsDialog = typeof import("./MailboxSettingsDialog");
export type MailboxCreationContext = { currentUserEmail: string | null; contactDirectory: MailContactDirectory };
export function createMailboxCreation(
  props: MailboxCreationContext,
  messages: Accessor<ReturnType<typeof mailOverviewMessages.resolve>["t"]>,
) {
  const createMailbox = mutations.create<{ mailbox: Mailbox; settings?: SettingsDialog } | null, void>({
    mutation: async (_input, { abortSignal }) => {
      const values = await prompts.form({
        title: messages().newMailbox,
        icon: "ti ti-mail-plus",
        fields: {
          name: { type: "text", label: messages().name, description: messages().nameDescription, required: true },
          description: {
            type: "text",
            label: messages().description,
            description: messages().descriptionDescription,
            multiline: true,
            lines: 3,
          },
        },
        confirmText: messages().createMailbox,
      });
      if (!values || abortSignal.aborted) return null;
      // The follow-up dialog loads during the request, behind the same pending state. Without its code, for example
      // in a tab opened before a release, the new mailbox still opens and its settings stay one click away.
      const settings = import("./MailboxSettingsDialog").catch(() => undefined);
      const response = await apiClient.mailboxes.$post(
        { json: { name: values.name, description: values.description || null } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedCreateMailbox));
      return { mailbox: await response.json(), settings: await settings };
    },
    onSuccess: (created) => {
      if (!created) return;
      const { mailbox, settings } = created;
      toast.success(messages().mailboxCreated);
      if (!settings) return navigateTo(`/app/mail/${mailbox.id}`);
      void settings
        .openMailboxSettingsDialog({
          mailboxId: mailbox.id,
          currentUserEmail: props.currentUserEmail,
          contactDirectory: props.contactDirectory,
          initialTab: "delivery",
        })
        .then((result) => navigateTo(result.deleted ? "/app/mail" : `/app/mail/${mailbox.id}`));
    },
    onError: (error) => prompts.error(error.message),
  });

  onCleanup(() => createMailbox.abort());
  return createMailbox;
}
