import type { GeoAvailabilityData } from "@k2b/cloud/contracts/geo";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { announce, Button, InlineGuidance, TextInput, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact } from "../../service";
import { resolveContactName } from "../../shared";
import { readErrorMessage } from "./api";
import { AddressStreetField } from "./ContactUpsertForm.fields";
import { buildAddressPayload, contactToUpsertDraft, editAddressField } from "./ContactUpsertForm.model";
import { contactFormErrorMessage, contactFormMessages, contactRowLabels } from "./contact-form-messages";
import { detailMessages } from "./detail-messages";

type Props = {
  contact: Contact;
  addressId: string;
  geoAvailability?: GeoAvailabilityData;
  onCancel: () => void;
  onSaved: (contact: Contact) => void;
  onReload: () => void;
};

/** One address in the contact workspace, guarded by the revision read on entry. */
export default function ContactAddressEditor(props: Props) {
  const locale = useLocale();
  const t = () => contactFormMessages.resolve([locale()]).t;
  const detail = () => detailMessages.resolve([locale()]).t;
  const contact = props.contact;
  const index = contact.addresses.findIndex((address) => address.id === props.addressId);
  const draft = contactToUpsertDraft(contact, contactRowLabels(t()));
  const [row, setRow] = createSignal(draft.addresses[index]!);
  const [conflict, setConflict] = createSignal(false);
  let disposed = false;
  let heading: HTMLHeadingElement | undefined;
  onMount(() => heading?.focus({ preventScroll: true }));
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const edit = (field: Parameters<typeof editAddressField>[1], value: string) =>
    setRow((current) => editAddressField(current, field, value));

  type AddressPatch = { addresses: ReturnType<typeof buildAddressPayload>; expectedUpdatedAt: string };
  const saveMutation = mutations.create<Contact, AddressPatch>({
    mutation: async (payload, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].contacts[":contactId"].$patch(
        { param: { bookId: contact.bookId, contactId: contact.id }, json: payload },
        { init: { signal: abortSignal } },
      );
      if (response.status === 409) setConflict(true);
      if (!response.ok) throw new Error(await readErrorMessage(response, detail().updateContactFailed));
      return await response.json();
    },
    onSuccess: (contact) => {
      if (disposed) return;
      props.onSaved(contact);
      announce(detail().contactUpdated);
    },
    onError: (error) => setSaveError(error.message),
  });
  onCleanup(() => {
    disposed = true;
    saveMutation.abort();
  });

  const save = () => {
    if (saveMutation.loading() || conflict()) return;
    setSaveError(null);
    try {
      // Only the addresses travel, guarded by the revision this editor read: a concurrent edit answers 409.
      const [edited] = buildAddressPayload([row()]);
      if (!edited) throw new Error(t().validationAddressFields);
      const addresses = contact.addresses.map((address, rowIndex) => {
        if (rowIndex === index) return edited;
        const { label, recipientName, companyName, line1, line2, postalCode, city, stateRegion, countryCode } = address;
        return { label, recipientName, companyName, line1, line2, postalCode, city, stateRegion, countryCode };
      });
      void saveMutation.mutate({ addresses, expectedUpdatedAt: contact.updatedAt });
    } catch (error) {
      setSaveError(contactFormErrorMessage(error, t(), t().prepareFailed));
    }
  };

  return (
    <form
      class="contacts-address-editor"
      aria-label={t().editAddressTitle}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div class="contacts-address-editor__heading">
        <div class="contacts-address-editor__titlebar">
          <Button class="contacts-address-editor__phone-back" variant="ghost" aria-label={detail().backToContact} onClick={props.onCancel}>
            <i class="ti ti-chevron-left" aria-hidden="true" />
          </Button>
          <h2 ref={heading} tabindex="-1">
            {t().editAddressTitle}
          </h2>
        </div>
        <p class="text-sm text-dimmed">{[row().label, resolveContactName(contact, detail().unnamedContact)].filter(Boolean).join(" · ")}</p>
      </div>
      <fieldset class="contacts-address-editor__fields" disabled={saveMutation.loading()}>
        <div class="contacts-address-editor__wide contacts-address-editor__street">
          <AddressStreetField row={row()} setRow={setRow} geoAvailability={props.geoAvailability} />
          <Show when={props.geoAvailability?.configured === false}>
            <p class="contacts-address-editor__empty-hint" aria-hidden="true" />
          </Show>
        </div>
        <div class="contacts-address-editor__wide">
          <TextInput
            icon={false}
            label={t().focusedAddressLine2}
            placeholder={t().focusedAddressLine2Placeholder}
            value={() => row().line2}
            onValueChange={(value) => edit("line2", value)}
          />
        </div>
        <TextInput
          icon={false}
          label={t().focusedPostalCode}
          placeholder={t().postalCodePlaceholder}
          required
          value={() => row().postalCode}
          onValueChange={(value) => edit("postalCode", value)}
        />
        <TextInput
          icon={false}
          label={t().city}
          placeholder={t().cityPlaceholder}
          required
          value={() => row().city}
          onValueChange={(value) => edit("city", value)}
        />
        <TextInput
          icon={false}
          label={t().focusedCountry}
          required
          placeholder={t().countryCodePlaceholder}
          value={() => row().countryCode}
          onValueChange={(value) => edit("countryCode", value)}
        />
      </fieldset>
      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={saveMutation.loading()} disabled={saveMutation.loading() || conflict()}>
          {t().save}
        </Button>
        <Button variant="secondary" onClick={props.onCancel} data-workspace-detail-close="">
          {t().cancel}
        </Button>
      </div>
      <Show when={saveError()}>
        {(error) => (
          <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
            {error()}
            <Show when={conflict()}>
              <p>{t().addressConflictHint}</p>
              <Button variant="secondary" onClick={props.onReload}>
                {t().reloadContact}
              </Button>
            </Show>
          </InlineGuidance>
        )}
      </Show>
    </form>
  );
}
