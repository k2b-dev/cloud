import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact, ContactRef } from "../../service";
import { resolveContactName } from "../../shared";
import { readErrorMessage } from "./api";
import { openBookSettingsDialog } from "./BookSettingsDialog";
import ContactSearchPicker from "./ContactSearchPicker";
import ContactTagsPicker from "./ContactTagsPicker";
import { buildContactPayload, contactToUpsertDraft } from "./ContactUpsertForm.model";
import { detailMessages } from "./detail-messages";

type Props = {
  contact: Contact;
  onCancel: () => void;
  onSaved: (contact: Contact) => void;
  onEditAll: () => void;
};

const toContactRef = (contact: Contact): ContactRef => ({
  id: contact.id,
  label: contact.label,
  firstName: contact.firstName,
  lastName: contact.lastName,
  companyName: contact.companyName,
  jobTitle: contact.jobTitle,
});

/** Focused editor for the fields users change most often on a record page. */
export default function ContactQuickEdit(props: Props) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const initial = contactToUpsertDraft(props.contact);
  const [label, setLabel] = createSignal(initial.label);
  const [firstName, setFirstName] = createSignal(initial.firstName);
  const [lastName, setLastName] = createSignal(initial.lastName);
  const [companyName, setCompanyName] = createSignal(initial.companyName);
  const [jobTitle, setJobTitle] = createSignal(initial.jobTitle);
  const [email, setEmail] = createSignal(initial.emails[0]?.email ?? "");
  const [phone, setPhone] = createSignal(initial.phones[0]?.phone ?? "");
  const [parentRef, setParentRef] = createSignal<ContactRef | null>(initial.parentRef);
  const [tagIds, setTagIds] = createSignal(initial.tagIds);

  const saveMutation = mutations.create<Contact, { bookId: string; contactId: string; payload: ReturnType<typeof buildContactPayload> }>({
    mutation: async ({ bookId, contactId, payload }, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].contacts[":contactId"].$patch(
        {
          param: { bookId, contactId },
          json: payload,
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().updateContactFailed));
      return await response.json();
    },
    onSuccess: (contact) => {
      toast.success(t().contactUpdated);
      props.onSaved(contact);
    },
    onError: (error) => prompts.error(error.message),
  });

  onCleanup(() => saveMutation.abort());

  const save = () => {
    try {
      const draft = contactToUpsertDraft(props.contact);
      const emails = [...draft.emails];
      const phones = [...draft.phones];
      emails[0] = { label: emails[0]?.label ?? "Email", email: email() };
      phones[0] = { label: phones[0]?.label ?? "Telephone", phone: phone() };

      const payload = buildContactPayload({
        ...draft,
        label: label(),
        firstName: firstName(),
        lastName: lastName(),
        companyName: companyName(),
        jobTitle: jobTitle(),
        emails,
        phones,
        parentRef: parentRef(),
        tagIds: tagIds(),
      });
      void saveMutation.mutate({
        bookId: props.contact.bookId,
        contactId: props.contact.id,
        payload: { ...payload, tagIds: [...(payload.tagIds ?? [])] },
      });
    } catch (error) {
      void prompts.error(error instanceof Error ? error.message : t().prepareContactUpdateFailed);
    }
  };

  const openParentPicker = async () => {
    const picked = await prompts.dialog<Contact | null>(
      (close) => (
        <ContactSearchPicker bookId={props.contact.bookId} excludeIds={[props.contact.id]} onSelect={(contact) => close(contact)} />
      ),
      {
        title: t().pickParentContact,
        icon: "ti ti-corner-down-right",
        size: "medium",
      },
    );
    if (picked) setParentRef(toContactRef(picked));
  };

  return (
    <form
      class="flex flex-col gap-4"
      data-contacts-editor="true"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextInput label={t().firstName} value={firstName} onValueChange={setFirstName} autocomplete="given-name" />
        <TextInput label={t().lastName} value={lastName} onValueChange={setLastName} autocomplete="family-name" />
        <div class="sm:col-span-2">
          <TextInput label={t().displayName} description={t().displayNameHint} value={label} onValueChange={setLabel} />
        </div>
        <TextInput label={t().company} value={companyName} onValueChange={setCompanyName} autocomplete="organization" />
        <TextInput label={t().jobTitle} value={jobTitle} onValueChange={setJobTitle} autocomplete="organization-title" />
        <TextInput label={t().primaryEmail} type="email" value={email} onValueChange={setEmail} autocomplete="email" />
        <TextInput label={t().primaryPhone} type="tel" value={phone} onValueChange={setPhone} autocomplete="tel" />
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <span class="text-label mb-1.5 block text-xs">{t().organization}</span>
          <Show
            when={parentRef()}
            fallback={
              <Button variant="ghost" size="sm" onClick={openParentPicker}>
                <i class="ti ti-corner-down-right" /> {t().chooseParent}
              </Button>
            }
          >
            {(parent) => (
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="rounded-md bg-[var(--ui-surface-subtle)] px-2 py-1 text-xs text-primary">{resolveContactName(parent())}</span>
                <Button variant="ghost" size="sm" onClick={openParentPicker}>
                  {t().change}
                </Button>
                <Button variant="ghost" size="sm" class="text-dimmed" onClick={() => setParentRef(null)}>
                  {t().clear}
                </Button>
              </div>
            )}
          </Show>
        </div>
        <div>
          <span class="text-label mb-1.5 block text-xs">{t().tags}</span>
          <ContactTagsPicker
            bookId={props.contact.bookId}
            selectedIds={tagIds()}
            onChange={setTagIds}
            onManage={async () => (await openBookSettingsDialog({ bookId: props.contact.bookId, initialTab: "tags" })).workspaceChanged}
            compact
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" class="text-dimmed" onClick={props.onEditAll}>
          {t().editAllFields} <i class="ti ti-arrow-up-right" />
        </Button>
        <div class="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={props.onCancel} disabled={saveMutation.loading()}>
            {t().cancel}
          </Button>
          <Button type="submit" size="sm" loading={saveMutation.loading()}>
            <i class="ti ti-check" />
            {t().save}
          </Button>
        </div>
      </div>
    </form>
  );
}
