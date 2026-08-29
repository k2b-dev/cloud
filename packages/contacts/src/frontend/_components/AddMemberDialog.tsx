import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, PanelDialog, prompts, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact, ContactRef } from "../../service";
import { resolveContactName } from "../../shared";
import { readErrorMessage } from "./api";
import ContactSearchPicker from "./ContactSearchPicker";
import ContactUpsertForm from "./ContactUpsertForm";
import { detailMessages } from "./detail-messages";

type Props = {
  parent: Contact;
  /** Resolves with the saved/linked member, or null if cancelled. */
  close: (member: Contact | null) => void;
};

/**
 * Two-mode dialog for attaching a member to a parent contact:
 *
 *  - **pick**: search the parent's book and link an existing contact.
 *  - **create**: open the upsert form pre-filled with the parent reference.
 *
 * The server validates the cycle / same-book / self rules, so the picker only
 * has to exclude the parent itself client-side. Linking is a single PATCH.
 */
export default function AddMemberDialog(props: Props) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const [mode, setMode] = createSignal<"pick" | "create">("pick");

  const parentRef: ContactRef = {
    id: props.parent.id,
    label: props.parent.label,
    firstName: props.parent.firstName,
    lastName: props.parent.lastName,
    companyName: props.parent.companyName,
    jobTitle: props.parent.jobTitle,
  };

  const linkMutation = mutations.create<Contact, { bookId: string; contactId: string; parentContactId: string }>({
    mutation: async ({ bookId, contactId, parentContactId }, { abortSignal }) => {
      const res = await apiClient.books[":bookId"].contacts[":contactId"].$patch(
        {
          param: { bookId, contactId },
          json: { parentContactId },
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readErrorMessage(res, t().linkMemberFailed));
      return await res.json();
    },
    onSuccess: (linked) => props.close(linked),
    onError: (error) => prompts.error(error.message),
  });

  onCleanup(() => linkMutation.abort());

  return (
    <Show
      when={mode() === "pick"}
      fallback={
        <ContactUpsertForm
          mode="create"
          bookId={props.parent.bookId}
          defaultParent={parentRef}
          title={t().newMember}
          subtitle={t().belongsTo({ name: resolveContactName(props.parent) })}
          icon="ti ti-user-plus"
          onCancel={() => setMode("pick")}
          onSaved={(created) => props.close(created)}
        />
      }
    >
      <PanelDialog>
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <PanelDialog.Header
            title={t().addMemberTo({ name: resolveContactName(props.parent) })}
            subtitle={t().addMemberHint}
            icon="ti ti-users-plus"
            close={() => props.close(null)}
          />
          <PanelDialog.Body>
            <PanelDialog.Section title={t().existingContact} subtitle={t().existingContactHint} icon="ti ti-search">
              <ContactSearchPicker
                bookId={props.parent.bookId}
                excludeIds={[props.parent.id]}
                placeholder={t().searchContactsInBook}
                onSelect={(contact) => {
                  if (linkMutation.loading()) return;
                  linkMutation.mutate({ bookId: contact.bookId, contactId: contact.id, parentContactId: props.parent.id });
                }}
              />
            </PanelDialog.Section>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <Button type="button" variant="secondary" size="sm" onClick={() => props.close(null)}>
              {t().cancel}
            </Button>
            <Button type="button" size="sm" onClick={() => setMode("create")}>
              <i class="ti ti-plus" /> {t().createNewContact}
            </Button>
          </PanelDialog.Footer>
        </div>
      </PanelDialog>
    </Show>
  );
}
