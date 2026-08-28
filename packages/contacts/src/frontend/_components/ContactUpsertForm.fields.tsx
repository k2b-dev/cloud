import { Button, IconButton, PanelDialog, RemoveButton, TextInput, Tooltip, useLocale } from "@k2b/ui";
import type { Accessor, Setter } from "solid-js";
import { Index } from "solid-js";
import { type ContactFormText, contactFormMessages, contactRowLabels } from "./contact-form-messages";
import {
  type EditableAddress,
  type EditableBankAccount,
  type EditableEmail,
  type EditablePhone,
  type EditableWebsite,
  emptyAddressRow,
  emptyBankAccountRow,
  emptyEmailRow,
  emptyPhoneRow,
  emptyWebsiteRow,
} from "./ContactUpsertForm.model";

type RowsProps<T> = {
  rows: Accessor<T[]>;
  setRows: Setter<T[]>;
};

const updateRow = <T,>(rows: T[], index: number, patch: Partial<T>): T[] =>
  rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));

const moveRow = <T,>(rows: T[], from: number, to: number): T[] => {
  if (from === to || to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  const [row] = next.splice(from, 1);
  if (row !== undefined) next.splice(to, 0, row);
  return next;
};

type ContactPointKind = "email" | "phone" | "website";

/** Complete per-noun action labels — never assembled from a translated noun. */
const contactPointText = (t: ContactFormText, kind: ContactPointKind) => {
  switch (kind) {
    case "email":
      return { makePrimary: t.makePrimaryEmail, moveUp: t.moveEmailUp, moveDown: t.moveEmailDown, remove: t.removeEmail };
    case "phone":
      return { makePrimary: t.makePrimaryPhone, moveUp: t.movePhoneUp, moveDown: t.movePhoneDown, remove: t.removePhone };
    case "website":
      return { makePrimary: t.makePrimaryWebsite, moveUp: t.moveWebsiteUp, moveDown: t.moveWebsiteDown, remove: t.removeWebsite };
  }
};

const ContactPointActions = <T,>(props: { rows: Accessor<T[]>; setRows: Setter<T[]>; index: number; kind: ContactPointKind }) => {
  const locale = useLocale();
  const t = () => contactFormMessages.resolve([locale()]).t;
  const text = () => contactPointText(t(), props.kind);
  return (
    <div class="flex items-center justify-end gap-0.5">
      {props.index === 0 ? (
        <span class="mr-1 text-[11px] font-medium text-secondary">{t().primary}</span>
      ) : (
        <Tooltip.Anchor content={text().makePrimary}>
          <IconButton
            size="xs"
            class="text-dimmed"
            label={text().makePrimary}
            onClick={() => props.setRows((rows) => moveRow(rows, props.index, 0))}
          >
            <i class="ti ti-star" />
          </IconButton>
        </Tooltip.Anchor>
      )}
      <Tooltip.Anchor content={t().moveUp}>
        <IconButton
          size="xs"
          class="text-dimmed"
          label={text().moveUp}
          disabled={props.index === 0}
          onClick={() => props.setRows((rows) => moveRow(rows, props.index, props.index - 1))}
        >
          <i class="ti ti-chevron-up" />
        </IconButton>
      </Tooltip.Anchor>
      <Tooltip.Anchor content={t().moveDown}>
        <IconButton
          size="xs"
          class="text-dimmed"
          label={text().moveDown}
          disabled={props.index === props.rows().length - 1}
          onClick={() => props.setRows((rows) => moveRow(rows, props.index, props.index + 1))}
        >
          <i class="ti ti-chevron-down" />
        </IconButton>
      </Tooltip.Anchor>
      <RemoveButton ariaLabel={text().remove} onClick={() => props.setRows((rows) => rows.filter((_, i) => i !== props.index))} />
    </div>
  );
};

export const ReachFields = (props: {
  emails: Accessor<EditableEmail[]>;
  setEmails: Setter<EditableEmail[]>;
  phones: Accessor<EditablePhone[]>;
  setPhones: Setter<EditablePhone[]>;
  websites: Accessor<EditableWebsite[]>;
  setWebsites: Setter<EditableWebsite[]>;
}) => {
  const locale = useLocale();
  const t = () => contactFormMessages.resolve([locale()]).t;
  return (
    <PanelDialog.Section title={t().reachTitle} subtitle={t().reachSubtitle} icon="ti ti-address-book">
      <div class="space-y-5">
        <div class="space-y-2">
          <Index each={props.emails()}>
            {(email, index) => (
              <div class="grid grid-cols-1 md:grid-cols-[140px_1fr_auto] gap-2 items-center">
                <TextInput
                  aria-label={t().emailLabelAria}
                  placeholder={t().emailLabelPlaceholder}
                  value={() => email().label}
                  onValueChange={(value) => props.setEmails((rows) => updateRow(rows, index, { label: value }))}
                />
                <TextInput
                  aria-label={t().emailAddressAria}
                  placeholder={t().emailPlaceholder}
                  icon="ti ti-mail text-blue-500 dark:text-blue-400"
                  value={() => email().email}
                  onValueChange={(value) => props.setEmails((rows) => updateRow(rows, index, { email: value }))}
                />
                <ContactPointActions rows={props.emails} setRows={props.setEmails} index={index} kind="email" />
              </div>
            )}
          </Index>
          <Button
            variant="ghost"
            size="xs"
            class="text-xs text-dimmed hover:text-primary"
            onClick={() => props.setEmails([...props.emails(), emptyEmailRow(contactRowLabels(t()))])}
          >
            <i class="ti ti-plus" /> {t().addEmail}
          </Button>
        </div>

        <div class="space-y-2">
          <Index each={props.phones()}>
            {(phone, index) => (
              <div class="grid grid-cols-1 md:grid-cols-[140px_1fr_auto] gap-2 items-center">
                <TextInput
                  aria-label={t().phoneLabelAria}
                  placeholder={t().phoneLabelPlaceholder}
                  value={() => phone().label}
                  onValueChange={(value) => props.setPhones((rows) => updateRow(rows, index, { label: value }))}
                />
                <TextInput
                  aria-label={t().phoneNumberAria}
                  placeholder={t().phonePlaceholder}
                  icon="ti ti-phone text-green-600 dark:text-green-400"
                  value={() => phone().phone}
                  onValueChange={(value) => props.setPhones((rows) => updateRow(rows, index, { phone: value }))}
                />
                <ContactPointActions rows={props.phones} setRows={props.setPhones} index={index} kind="phone" />
              </div>
            )}
          </Index>
          <Button
            variant="ghost"
            size="xs"
            class="text-xs text-dimmed hover:text-primary"
            onClick={() => props.setPhones([...props.phones(), emptyPhoneRow(contactRowLabels(t()))])}
          >
            <i class="ti ti-plus" /> {t().addPhone}
          </Button>
        </div>

        <div class="space-y-2">
          <Index each={props.websites()}>
            {(website, index) => (
              <div class="grid grid-cols-1 md:grid-cols-[140px_1fr_auto] gap-2 items-center">
                <TextInput
                  aria-label={t().websiteLabelAria}
                  placeholder={t().websiteLabelPlaceholder}
                  value={() => website().label}
                  onValueChange={(value) => props.setWebsites((rows) => updateRow(rows, index, { label: value }))}
                />
                <TextInput
                  aria-label={t().websiteUrlAria}
                  placeholder={t().websiteUrlPlaceholder}
                  icon="ti ti-world text-purple-600 dark:text-purple-400"
                  value={() => website().url}
                  onValueChange={(value) => props.setWebsites((rows) => updateRow(rows, index, { url: value }))}
                />
                <ContactPointActions rows={props.websites} setRows={props.setWebsites} index={index} kind="website" />
              </div>
            )}
          </Index>
          <Button
            variant="ghost"
            size="xs"
            class="text-xs text-dimmed hover:text-primary"
            onClick={() => props.setWebsites([...props.websites(), emptyWebsiteRow(contactRowLabels(t()))])}
          >
            <i class="ti ti-plus" /> {t().addWebsite}
          </Button>
        </div>
      </div>
    </PanelDialog.Section>
  );
};

export const AddressFields = (props: RowsProps<EditableAddress>) => {
  const locale = useLocale();
  const t = () => contactFormMessages.resolve([locale()]).t;
  return (
    <PanelDialog.Section title={t().addressesTitle} subtitle={t().addressesSubtitle} icon="ti ti-map-pin">
      <div class="space-y-3">
        <Index each={props.rows()}>
          {(address, index) => (
            <div class="rounded-lg bg-zinc-200/60 p-3 dark:bg-zinc-800/40">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <TextInput
                  label={t().label}
                  placeholder={t().addressLabelPlaceholder}
                  icon="ti ti-tag"
                  value={() => address().label}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { label: value }))}
                />
                <TextInput
                  label={t().recipient}
                  placeholder={t().recipientPlaceholder}
                  icon="ti ti-user"
                  value={() => address().recipientName}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { recipientName: value }))}
                />
                <div class="md:col-span-2">
                  <TextInput
                    label={t().company}
                    placeholder={t().companyPlaceholder}
                    icon="ti ti-building"
                    value={() => address().companyName}
                    onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { companyName: value }))}
                  />
                </div>
                <TextInput
                  label={t().addressLine1}
                  placeholder={t().addressLine1Placeholder}
                  icon="ti ti-home"
                  required
                  value={() => address().line1}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { line1: value }))}
                />
                <TextInput
                  label={t().addressLine2}
                  placeholder={t().addressLine2Placeholder}
                  icon="ti ti-home"
                  value={() => address().line2}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { line2: value }))}
                />
                <TextInput
                  label={t().postalCode}
                  placeholder={t().postalCodePlaceholder}
                  icon="ti ti-map-pin"
                  required
                  value={() => address().postalCode}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { postalCode: value }))}
                />
                <TextInput
                  label={t().city}
                  placeholder={t().cityPlaceholder}
                  icon="ti ti-building-community"
                  required
                  value={() => address().city}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { city: value }))}
                />
                <TextInput
                  label={t().stateRegion}
                  placeholder={t().stateRegionPlaceholder}
                  description={t().stateRegionDescription}
                  icon="ti ti-map-2"
                  value={() => address().stateRegion}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { stateRegion: value }))}
                />
                <TextInput
                  label={t().countryCode}
                  placeholder={t().countryCodePlaceholder}
                  description={t().countryCodeDescription}
                  icon="ti ti-flag"
                  value={() => address().countryCode}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { countryCode: value }))}
                />
              </div>
              <div class="mt-4 flex justify-end">
                <Button
                  variant="ghost"
                  size="xs"
                  class="text-xs text-dimmed hover:text-red-600 dark:hover:text-red-400"
                  onClick={() => props.setRows((rows) => rows.filter((_, i) => i !== index))}
                >
                  <i class="ti ti-trash" /> {t().removeAddress}
                </Button>
              </div>
            </div>
          )}
        </Index>
        <Button
          variant="ghost"
          size="xs"
          class="text-xs text-dimmed hover:text-primary"
          onClick={() => props.setRows([...props.rows(), emptyAddressRow(contactRowLabels(t()))])}
        >
          <i class="ti ti-plus" /> {t().addAddress}
        </Button>
      </div>
    </PanelDialog.Section>
  );
};

export const BankAccountFields = (props: RowsProps<EditableBankAccount>) => {
  const locale = useLocale();
  const t = () => contactFormMessages.resolve([locale()]).t;
  return (
    <PanelDialog.Section title={t().bankDetailsTitle} subtitle={t().bankDetailsSubtitle} icon="ti ti-building-bank">
      <div class="space-y-3">
        <Index each={props.rows()}>
          {(account, index) => (
            <div class="rounded-lg bg-zinc-200/60 p-3 dark:bg-zinc-800/40">
              <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                <TextInput
                  label={t().label}
                  placeholder={t().bankLabelPlaceholder}
                  icon="ti ti-tag"
                  value={() => account().label}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { label: value }))}
                />
                <TextInput
                  label={t().accountHolder}
                  placeholder={t().accountHolderPlaceholder}
                  icon="ti ti-user"
                  required
                  value={() => account().accountHolderName}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { accountHolderName: value }))}
                />
                <TextInput
                  label={t().iban}
                  placeholder={t().ibanPlaceholder}
                  icon="ti ti-credit-card"
                  required
                  value={() => account().iban}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { iban: value }))}
                />
                <TextInput
                  label={t().bic}
                  placeholder={t().bicPlaceholder}
                  icon="ti ti-building-bank"
                  value={() => account().bic}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { bic: value }))}
                />
                <TextInput
                  label={t().bankName}
                  placeholder={t().bankNamePlaceholder}
                  icon="ti ti-building-bank"
                  value={() => account().bankName}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { bankName: value }))}
                />
                <TextInput
                  label={t().note}
                  placeholder={t().notePlaceholder}
                  icon="ti ti-notes"
                  value={() => account().note}
                  onValueChange={(value) => props.setRows((rows) => updateRow(rows, index, { note: value }))}
                />
              </div>
              <div class="mt-4 flex justify-end">
                <Button
                  variant="ghost"
                  size="xs"
                  class="text-xs text-dimmed hover:text-red-600 dark:hover:text-red-400"
                  onClick={() => props.setRows((rows) => rows.filter((_, i) => i !== index))}
                >
                  <i class="ti ti-trash" /> {t().removeBankDetails}
                </Button>
              </div>
            </div>
          )}
        </Index>
        <Button
          variant="ghost"
          size="xs"
          class="text-xs text-dimmed hover:text-primary"
          onClick={() => props.setRows([...props.rows(), emptyBankAccountRow(contactRowLabels(t()))])}
        >
          <i class="ti ti-plus" /> {t().addBankDetails}
        </Button>
      </div>
    </PanelDialog.Section>
  );
};
