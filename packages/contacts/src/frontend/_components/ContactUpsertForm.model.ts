import type { GeoAddress, GeoPoint, GeoProvenance } from "@k2b/cloud/contracts/geo";
import type { Contact, ContactRef, CreateContactInput } from "../../service";
import { isSafeWebsiteUrl } from "../../shared";

export type EditableEmail = { label: string; email: string };
export type EditablePhone = { label: string; phone: string };
export type EditableWebsite = { label: string; url: string };
export type EditableBankAccount = {
  label: string;
  accountHolderName: string;
  iban: string;
  bic: string;
  bankName: string;
  note: string;
};
/**
 * Where the row's location stands while editing: `picked` carries a suggestion's point, `changed` dropped a known
 * location, `own` keeps the typed text on purpose. `idle` rows are looked up after saving, like `changed` and `own`.
 */
export type AddressGeoState = "idle" | "known" | "picked" | "changed" | "own";
export type EditableAddress = {
  label: string;
  recipientName: string;
  companyName: string;
  line1: string;
  line2: string;
  postalCode: string;
  city: string;
  stateRegion: string;
  countryCode: string;
  geo: AddressGeoState;
  /** Point of the chosen suggestion; dropped by any change to a location field. */
  location: { point: GeoPoint; provenance: GeoProvenance } | null;
};

type AddressLocationField = "line1" | "postalCode" | "city" | "stateRegion" | "countryCode";

/** A typed change to a location field drops a picked or known point; label, recipient and second line keep it. */
const LOCATION_FIELDS: readonly string[] = ["line1", "postalCode", "city", "stateRegion", "countryCode"] satisfies AddressLocationField[];
export const editAddressField = (
  row: EditableAddress,
  field: Exclude<keyof EditableAddress, "geo" | "location">,
  value: string,
): EditableAddress => {
  if (!LOCATION_FIELDS.includes(field)) return { ...row, [field]: value };
  if (row[field] === value) return row;
  const geo = row.geo === "picked" || row.geo === "known" || row.geo === "changed" ? "changed" : row.geo;
  return { ...row, [field]: value, geo, location: null };
};

/**
 * A chosen suggestion replaces every location field, also with an empty value, so its point never sits beside a
 * postal code or region of the previous address. Every field stays editable.
 */
export const pickAddressSuggestion = (row: EditableAddress, address: GeoAddress): EditableAddress => ({
  ...row,
  line1: address.line1,
  postalCode: address.postalCode,
  city: address.city,
  stateRegion: address.stateRegion,
  countryCode: address.countryCode,
  geo: "picked",
  location: { point: address.point, provenance: address.provenance },
});

export type ContactUpsertDraft = {
  label: string;
  firstName: string;
  lastName: string;
  companyName: string;
  department: string;
  jobTitle: string;
  vatId: string;
  birthday: string;
  salutation: string;
  pronouns: string;
  preferredLanguage: string;
  parentRef: ContactRef | null;
  tagIds: string[];
  emails: EditableEmail[];
  phones: EditablePhone[];
  addresses: EditableAddress[];
  websites: EditableWebsite[];
  bankAccounts: EditableBankAccount[];
};

export type ContactUpsertInitialValues = {
  label?: string;
  email?: string;
};

/**
 * Stable identifiers for client-side validation failures. The model is
 * locale-agnostic: it throws English base text plus a key, and the rendering
 * component maps the key through its message catalog.
 */
export type ContactFormValidationKey = "websiteUrl" | "addressFields" | "addressCountryCode" | "bankFields" | "birthdayFormat";

export class ContactFormValidationError extends Error {
  readonly key: ContactFormValidationKey;

  constructor(key: ContactFormValidationKey, message: string) {
    super(message);
    this.name = "ContactFormValidationError";
    this.key = key;
  }
}

/** Display labels seeded into new contact-point rows; callers pass localized values. */
export type ContactRowLabels = {
  email: string;
  phone: string;
  website: string;
  bank: string;
  address: string;
};

/**
 * Builds the editable form shape without dropping values that are outside a
 * compact editor. This lets focused editors patch a few common fields while
 * still sending the complete contact payload expected by the API.
 */
export const contactToUpsertDraft = (contact: Contact, rowLabels: ContactRowLabels): ContactUpsertDraft => ({
  label: contact.label ?? "",
  firstName: contact.firstName ?? "",
  lastName: contact.lastName ?? "",
  companyName: contact.companyName ?? "",
  department: contact.department ?? "",
  jobTitle: contact.jobTitle ?? "",
  vatId: contact.vatId ?? "",
  birthday: contact.birthday ?? "",
  salutation: contact.salutation ?? "",
  pronouns: contact.pronouns ?? "",
  preferredLanguage: contact.preferredLanguage ?? "",
  parentRef: contact.parent,
  tagIds: contact.tags.map((tag) => tag.id),
  emails: initialEmailRows(contact, rowLabels),
  phones: initialPhoneRows(contact, rowLabels),
  addresses: initialAddressRows(contact, rowLabels),
  websites: initialWebsiteRows(contact, rowLabels),
  bankAccounts: initialBankAccountRows(contact, rowLabels),
});

export type ContactQuickEditFields = Pick<
  ContactUpsertDraft,
  "label" | "firstName" | "lastName" | "companyName" | "jobTitle" | "parentRef" | "tagIds"
> & { email: string; phone: string };

/** Applies focused edits while preserving the remaining contact data. */
export const applyQuickEditFields = (contact: Contact, fields: ContactQuickEditFields, rowLabels: ContactRowLabels): ContactUpsertDraft => {
  const draft = contactToUpsertDraft(contact, rowLabels);
  const { email, phone, ...otherFields } = fields;
  const emails = [...draft.emails];
  const phones = [...draft.phones];
  emails[0] = { label: emails[0]?.label ?? rowLabels.email, email };
  phones[0] = { label: phones[0]?.label ?? rowLabels.phone, phone };
  return { ...draft, ...otherFields, emails, phones };
};

export const emptyEmailRow = (rowLabels: ContactRowLabels): EditableEmail => ({
  label: rowLabels.email,
  email: "",
});

export const emptyPhoneRow = (rowLabels: ContactRowLabels): EditablePhone => ({
  label: rowLabels.phone,
  phone: "",
});

export const emptyWebsiteRow = (rowLabels: ContactRowLabels): EditableWebsite => ({
  label: rowLabels.website,
  url: "",
});

export const emptyBankAccountRow = (rowLabels: ContactRowLabels): EditableBankAccount => ({
  label: rowLabels.bank,
  accountHolderName: "",
  iban: "",
  bic: "",
  bankName: "",
  note: "",
});

export const emptyAddressRow = (rowLabels: ContactRowLabels): EditableAddress => ({
  label: rowLabels.address,
  recipientName: "",
  companyName: "",
  line1: "",
  line2: "",
  postalCode: "",
  city: "",
  stateRegion: "",
  countryCode: "DE",
  geo: "idle",
  location: null,
});

export const initialEmailRows = (contact: Contact | null, rowLabels: ContactRowLabels): EditableEmail[] => {
  if (!contact) return [emptyEmailRow(rowLabels)];
  return contact.emails.length > 0
    ? contact.emails.map((email) => ({
        label: email.label?.trim() || rowLabels.email,
        email: email.email,
      }))
    : [emptyEmailRow(rowLabels)];
};

export const initialPhoneRows = (contact: Contact | null, rowLabels: ContactRowLabels): EditablePhone[] => {
  if (!contact) return [emptyPhoneRow(rowLabels)];
  return contact.phones.length > 0
    ? contact.phones.map((phone) => ({
        label: phone.label?.trim() || rowLabels.phone,
        phone: phone.phone,
      }))
    : [emptyPhoneRow(rowLabels)];
};

export const initialWebsiteRows = (contact: Contact | null, rowLabels: ContactRowLabels): EditableWebsite[] => {
  if (!contact) return [emptyWebsiteRow(rowLabels)];
  return contact.websites.length > 0
    ? contact.websites.map((website) => ({
        label: website.label?.trim() || rowLabels.website,
        url: website.url,
      }))
    : [emptyWebsiteRow(rowLabels)];
};

export const initialAddressRows = (contact: Contact | null, rowLabels: ContactRowLabels): EditableAddress[] => {
  if (!contact) return [emptyAddressRow(rowLabels)];
  return contact.addresses.length > 0
    ? contact.addresses.map((address) => ({
        label: address.label?.trim() || rowLabels.address,
        recipientName: address.recipientName ?? "",
        companyName: address.companyName ?? "",
        line1: address.line1,
        line2: address.line2 ?? "",
        postalCode: address.postalCode,
        city: address.city,
        stateRegion: address.stateRegion ?? "",
        countryCode: address.countryCode,
        geo: address.location ? ("known" as const) : ("idle" as const),
        location: null,
      }))
    : [emptyAddressRow(rowLabels)];
};

export const initialBankAccountRows = (contact: Contact | null, rowLabels: ContactRowLabels): EditableBankAccount[] => {
  if (!contact) return [];
  return contact.bankAccounts.map((account) => ({
    label: account.label?.trim() || rowLabels.bank,
    accountHolderName: account.accountHolderName,
    iban: account.iban,
    bic: account.bic ?? "",
    bankName: account.bankName ?? "",
    note: account.note ?? "",
  }));
};

export const createContactUpsertDraft = (initialValues: ContactUpsertInitialValues, rowLabels: ContactRowLabels): ContactUpsertDraft => ({
  label: initialValues.label?.trim() ?? "",
  firstName: "",
  lastName: "",
  companyName: "",
  department: "",
  jobTitle: "",
  vatId: "",
  birthday: "",
  salutation: "",
  pronouns: "",
  preferredLanguage: "",
  parentRef: null,
  tagIds: [],
  emails: [{ ...emptyEmailRow(rowLabels), email: initialValues.email?.trim() ?? "" }],
  phones: [emptyPhoneRow(rowLabels)],
  addresses: [emptyAddressRow(rowLabels)],
  websites: [emptyWebsiteRow(rowLabels)],
  bankAccounts: [],
});

const cleanText = (value: string): string | null => value.trim() || null;
const cleanUpperCompact = (value: string): string => value.replace(/\s+/g, "").toUpperCase();

const normalizeEmails = (rows: EditableEmail[]) =>
  rows
    .map((email) => ({
      label: cleanText(email.label),
      email: email.email.trim(),
    }))
    .filter((email) => email.email.length > 0);

const normalizePhones = (rows: EditablePhone[]) =>
  rows
    .map((phone) => ({
      label: cleanText(phone.label),
      phone: phone.phone.trim(),
    }))
    .filter((phone) => phone.phone.length > 0);

const normalizeWebsites = (rows: EditableWebsite[]) =>
  rows
    .map((website) => ({
      label: cleanText(website.label),
      url: website.url.trim(),
    }))
    .filter((website) => website.url.length > 0);

const validateWebsites = (websites: ReturnType<typeof normalizeWebsites>) => {
  for (const website of websites) {
    if (!isSafeWebsiteUrl(website.url))
      throw new ContactFormValidationError("websiteUrl", "Website URL must start with http:// or https://");
  }
};

const normalizeAddresses = (rows: EditableAddress[]) =>
  rows
    .map((address) => ({
      label: cleanText(address.label),
      recipientName: cleanText(address.recipientName),
      companyName: cleanText(address.companyName),
      line1: address.line1.trim(),
      line2: cleanText(address.line2),
      postalCode: address.postalCode.trim(),
      city: address.city.trim(),
      stateRegion: cleanText(address.stateRegion),
      countryCode: address.countryCode.trim().toUpperCase(),
      // Unchanged addresses keep their stored location on the server; only a fresh pick travels.
      ...(address.location ? { location: address.location } : {}),
    }))
    .filter(
      (address) =>
        address.line1.length > 0 ||
        address.postalCode.length > 0 ||
        address.city.length > 0 ||
        address.recipientName !== null ||
        address.companyName !== null,
    );

const validateAddresses = (addresses: ReturnType<typeof normalizeAddresses>) => {
  for (const address of addresses) {
    if (!address.line1 || !address.postalCode || !address.city)
      throw new ContactFormValidationError("addressFields", "Addresses need line1, postal code, and city");
    if (address.countryCode.length !== 2)
      throw new ContactFormValidationError("addressCountryCode", "Address country code must be 2 letters");
  }
};

const normalizeBankAccounts = (rows: EditableBankAccount[]) =>
  rows
    .map((account) => ({
      label: cleanText(account.label),
      accountHolderName: account.accountHolderName.trim(),
      iban: cleanUpperCompact(account.iban),
      bic: cleanUpperCompact(account.bic) || null,
      bankName: cleanText(account.bankName),
      note: cleanText(account.note),
    }))
    .filter((account) => account.accountHolderName.length > 0 || account.iban.length > 0 || account.bic || account.bankName);

const validateBankAccounts = (bankAccounts: ReturnType<typeof normalizeBankAccounts>) => {
  for (const account of bankAccounts) {
    if (!account.accountHolderName || !account.iban)
      throw new ContactFormValidationError("bankFields", "Bank details need account holder name and IBAN");
  }
};

const normalizeBirthday = (value: string): string | null => {
  const birthday = value.trim();
  if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
    throw new ContactFormValidationError("birthdayFormat", "Birthday must use format YYYY-MM-DD");
  }
  return birthday || null;
};

/** Validate address-only edits without involving unrelated contact fields. */
export const buildAddressPayload = (rows: EditableAddress[]) => {
  const addresses = normalizeAddresses(rows);
  validateAddresses(addresses);
  return addresses;
};

export const buildContactPayload = (draft: ContactUpsertDraft): CreateContactInput => {
  const emails = normalizeEmails(draft.emails);
  const phones = normalizePhones(draft.phones);
  const websites = normalizeWebsites(draft.websites);
  const addresses = normalizeAddresses(draft.addresses);
  const bankAccounts = normalizeBankAccounts(draft.bankAccounts);

  validateWebsites(websites);
  validateAddresses(addresses);
  validateBankAccounts(bankAccounts);

  return {
    label: cleanText(draft.label),
    firstName: cleanText(draft.firstName),
    lastName: cleanText(draft.lastName),
    companyName: cleanText(draft.companyName),
    department: cleanText(draft.department),
    jobTitle: cleanText(draft.jobTitle),
    vatId: cleanText(draft.vatId),
    birthday: normalizeBirthday(draft.birthday),
    salutation: cleanText(draft.salutation),
    pronouns: cleanText(draft.pronouns),
    preferredLanguage: cleanText(draft.preferredLanguage),
    parentContactId: draft.parentRef?.id ?? null,
    tagIds: draft.tagIds,
    emails,
    phones,
    addresses,
    websites,
    bankAccounts,
  };
};
