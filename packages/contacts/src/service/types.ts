import type { GeoPoint, GeoProvenance } from "@k2b/cloud/contracts/geo";

export type ContactBook = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ContactBookAdminListItem = ContactBook & {
  permissionCount: number;
  contactCount: number;
};

export type ContactSort = "name" | "updated" | "created" | "company";
export type ContactPresenceFilter = "all" | "yes" | "no";

export type ContactListFilter = {
  query?: string;
  tagIds?: string[];
  sort?: ContactSort;
  email?: ContactPresenceFilter;
  phone?: ContactPresenceFilter;
  /** User whose personal favorites constrain the result. Omit for no favorite filter. */
  favoriteUserId?: string;
};

export type ContactFavorite = {
  bookId: string;
  contactId: string;
  createdAt: string;
};

export type ContactDuplicateReason = "email" | "phone" | "name";

export type ContactDuplicateMatch = {
  first: Contact;
  second: Contact;
  reasons: ContactDuplicateReason[];
};

export type ContactEmail = {
  id: string;
  contactId: string;
  label: string | null;
  email: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type ContactPhone = {
  id: string;
  contactId: string;
  label: string | null;
  phone: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type ContactWebsite = {
  id: string;
  contactId: string;
  label: string | null;
  url: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type ContactBankAccount = {
  id: string;
  contactId: string;
  label: string | null;
  accountHolderName: string;
  iban: string;
  bic: string | null;
  bankName: string | null;
  note: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Where an address lies. Bound to the address text it was found for: any change of street,
 * postal code, city, region, or country drops it, and the next authorized detail view looks it up again.
 */
export type ContactAddressLocation =
  | { status: "found"; point: GeoPoint; provenance: GeoProvenance }
  /** The lookup found no house-number-level match; only a changed address searches again. */
  | { status: "not_found"; checkedAt: string };

export type ContactAddress = {
  id: string;
  contactId: string;
  label: string | null;
  recipientName: string | null;
  companyName: string | null;
  line1: string;
  line2: string | null;
  postalCode: string;
  city: string;
  stateRegion: string | null;
  countryCode: string;
  /** Null while the lookup is pending. */
  location: ContactAddressLocation | null;
  position: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Minimal contact fields used to render parent chips and member lists in the
 * UI without dragging full contact rows around. Always loaded inline in the
 * main contact query so a single round-trip resolves the hierarchy view.
 */
export type ContactRef = {
  id: string;
  label: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  jobTitle: string | null;
};

export type ContactTreeNode = ContactRef & {
  parentContactId: string | null;
  children: ContactTreeNode[];
};

export type ContactTree = {
  bookId: string;
  selectedId: string;
  root: ContactTreeNode;
};

export type Contact = {
  id: string;
  bookId: string;
  label: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  department: string | null;
  jobTitle: string | null;
  vatId: string | null;
  birthday: string | null;
  salutation: string | null;
  pronouns: string | null;
  preferredLanguage: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  addresses: ContactAddress[];
  websites: ContactWebsite[];
  bankAccounts: ContactBankAccount[];
  /** Direct parent in the hierarchy, null if this contact is at the root. */
  parentContactId: string | null;
  parent: ContactRef | null;
  /** Direct children only — UI does not load grandchildren in one go. */
  members: ContactRef[];
  /** Tags assigned to this contact (loaded inline). */
  tags: ContactTag[];
};

/**
 * One entry in a contact's notes timeline. Author is snapshotted at write
 * time so the note remains readable even if the user account is later
 * deleted. The user-id link is preserved for permission checks (and goes
 * NULL on user deletion via FK SET NULL).
 */
export type ContactNote = {
  id: string;
  contactId: string;
  authorUserId: string | null;
  authorDisplayName: string;
  authorAvatarHash: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
};

export type CreateContactNoteInput = {
  content: string;
};

export type UpdateContactNoteInput = {
  content: string;
};

export type ContactTag = {
  id: string;
  bookId: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateContactTagInput = {
  name: string;
  color: string;
};

export type UpdateContactTagInput = {
  name?: string;
  color?: string;
};

export type CreateBookInput = {
  name: string;
  description?: string;
};

export type UpdateBookInput = {
  name?: string;
  description?: string | null;
};

export type ContactEmailInput = {
  label?: string | null;
  email: string;
};

export type ContactPhoneInput = {
  label?: string | null;
  phone: string;
};

export type ContactWebsiteInput = {
  label?: string | null;
  url: string;
};

export type ContactBankAccountInput = {
  label?: string | null;
  accountHolderName: string;
  iban: string;
  bic?: string | null;
  bankName?: string | null;
  note?: string | null;
};

export type ContactAddressInput = {
  label?: string | null;
  recipientName?: string | null;
  companyName?: string | null;
  line1: string;
  line2?: string | null;
  postalCode: string;
  city: string;
  stateRegion?: string | null;
  countryCode: string;
  /** Point of a chosen address suggestion for exactly these fields. Unchanged addresses keep their location without it. */
  location?: { point: GeoPoint; provenance: GeoProvenance } | null;
};

export type CreateContactInput = {
  label?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  department?: string | null;
  jobTitle?: string | null;
  vatId?: string | null;
  birthday?: string | null;
  salutation?: string | null;
  pronouns?: string | null;
  preferredLanguage?: string | null;
  source?: string | null;
  parentContactId?: string | null;
  /** Replace all tag assignments. Pass undefined to leave unchanged, [] to clear all. */
  tagIds?: string[];
  emails?: ContactEmailInput[];
  phones?: ContactPhoneInput[];
  addresses?: ContactAddressInput[];
  websites?: ContactWebsiteInput[];
  bankAccounts?: ContactBankAccountInput[];
};

export type UpdateContactInput = {
  label?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  department?: string | null;
  jobTitle?: string | null;
  vatId?: string | null;
  birthday?: string | null;
  salutation?: string | null;
  pronouns?: string | null;
  preferredLanguage?: string | null;
  source?: string | null;
  parentContactId?: string | null;
  /** Replace all tag assignments. Pass undefined to leave unchanged, [] to clear all. */
  tagIds?: string[];
  emails?: ContactEmailInput[];
  phones?: ContactPhoneInput[];
  addresses?: ContactAddressInput[];
  websites?: ContactWebsiteInput[];
  bankAccounts?: ContactBankAccountInput[];
};
