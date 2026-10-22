import type { GeoAvailabilityData } from "@k2b/cloud/contracts/geo";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { announce, Button, InlineGuidance, PanelDialog, TextInput, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact } from "../../service";
import { resolveContactName } from "../../shared";
import { readErrorMessage } from "./api";
import { AddressStreetField } from "./ContactUpsertForm.fields";
import { buildContactPayload, contactToUpsertDraft, editAddressField } from "./ContactUpsertForm.model";
import { contactFormErrorMessage, contactFormMessages, contactRowLabels } from "./contact-form-messages";
import { detailMessages } from "./detail-messages";

type Props = {
  contact: Contact;
  /** Position of the address in the contact. */
  index: number;
  geoAvailability?: GeoAvailabilityData;
  onCancel: () => void;
  onSaved: (contact: Contact) => void;
};

/** Focused editor for one address, opened from its map. The rest of the contact is sent unchanged. */
export default function ContactAddressEditor(props: Props) {
  const locale = useLocale();
  const t = () => contactFormMessages.resolve([locale()]).t;
  const detail = () => detailMessages.resolve([locale()]).t;
  const draft = contactToUpsertDraft(props.contact, contactRowLabels(t()));
  const [row, setRow] = createSignal(draft.addresses[props.index]!);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const edit = (field: Parameters<typeof editAddressField>[1], value: string) =>
    setRow((current) => editAddressField(current, field, value));

  const saveMutation = mutations.create<Contact, ReturnType<typeof buildContactPayload>>({
    mutation: async (payload, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].contacts[":contactId"].$patch(
        { param: { bookId: props.contact.bookId, contactId: props.contact.id }, json: payload },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, detail().updateContactFailed));
      return await response.json();
    },
    onSuccess: (contact) => {
      props.onSaved(contact);
      announce(detail().contactUpdated);
    },
    onError: (error) => setSaveError(error.message),
  });
  onCleanup(() => saveMutation.abort());

  const save = () => {
    if (saveMutation.loading()) return;
    setSaveError(null);
    try {
      void saveMutation.mutate(
        buildContactPayload({ ...draft, addresses: draft.addresses.map((current, index) => (index === props.index ? row() : current)) }),
      );
    } catch (error) {
      setSaveError(contactFormErrorMessage(error, t(), t().prepareFailed));
    }
  };

  return (
    <PanelDialog>
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PanelDialog.Header
          title={t().editAddressTitle}
          subtitle={[row().label, resolveContactName(props.contact, detail().unnamedContact)].filter(Boolean).join(" · ")}
          icon="ti ti-map-pin"
          close={props.onCancel}
        />
        <PanelDialog.Body>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div class="sm:col-span-3">
              <AddressStreetField row={row()} setRow={setRow} geoAvailability={props.geoAvailability} />
            </div>
            <div class="sm:col-span-3">
              <TextInput
                label={t().addressLine2}
                placeholder={t().addressLine2Placeholder}
                icon="ti ti-home"
                value={() => row().line2}
                onValueChange={(value) => edit("line2", value)}
              />
            </div>
            <TextInput
              label={t().postalCode}
              placeholder={t().postalCodePlaceholder}
              icon="ti ti-map-pin"
              required
              value={() => row().postalCode}
              onValueChange={(value) => edit("postalCode", value)}
            />
            <TextInput
              label={t().city}
              placeholder={t().cityPlaceholder}
              icon="ti ti-building-community"
              required
              value={() => row().city}
              onValueChange={(value) => edit("city", value)}
            />
            <TextInput
              label={t().countryCode}
              placeholder={t().countryCodePlaceholder}
              icon="ti ti-flag"
              value={() => row().countryCode}
              onValueChange={(value) => edit("countryCode", value)}
            />
          </div>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <div class="flex w-full flex-col gap-2">
            <div class="h-16 shrink-0 overflow-y-auto" tabindex={saveError() ? 0 : undefined}>
              <Show when={saveError()}>
                {(error) => (
                  <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
                    {error()}
                  </InlineGuidance>
                )}
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" loading={saveMutation.loading()} disabled={saveMutation.loading()} onClick={save}>
                {t().save}
              </Button>
              <Button variant="secondary" size="sm" onClick={props.onCancel}>
                {t().cancel}
              </Button>
            </div>
          </div>
        </PanelDialog.Footer>
      </div>
    </PanelDialog>
  );
}
