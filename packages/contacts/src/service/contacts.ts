import { err, fail, ok, type PageParams, type Paginated, paginate, type Result } from "@k2b/stdlib";
import { capabilityIdempotencyConflict } from "@k2b/cloud/contracts";
import { type AccessSubject, buildAccessPrincipalCondition } from "@k2b/cloud/server";
import { sql } from "bun";
import { newShortId, withShortIdRetry } from "../lib/short-id";
import { resolveContactName, resolveStoredContactLabel } from "../shared";
import { emptyToNull, isUuid, type SqlExecutor, toDateOnly, toPgUuidArray } from "./shared";
import * as tags from "./tags";
import { buildContactTree, type ContactTreeRow } from "./tree";
import type {
  Contact,
  ContactAddress,
  ContactAddressInput,
  ContactBankAccount,
  ContactBankAccountInput,
  ContactDuplicateMatch,
  ContactDuplicateReason,
  ContactEmail,
  ContactEmailInput,
  ContactListFilter,
  ContactPhone,
  ContactPhoneInput,
  ContactRef,
  ContactTag,
  ContactTree,
  ContactWebsite,
  ContactWebsiteInput,
  CreateContactInput,
  UpdateContactInput,
} from "./types";

const normalizeContactIds = (ids: string[]): Result<string[]> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return fail(err.badInput("Choose at least one contact"));
  if (unique.some((id) => !isUuid(id))) return fail(err.badInput("Contact ids must be UUIDs"));
  return ok(unique);
};

type DbContact = {
  id: string;
  book_id: string;
  label: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  department: string | null;
  job_title: string | null;
  vat_id: string | null;
  birthday: Date | string | null;
  salutation: string | null;
  pronouns: string | null;
  preferred_language: string | null;
  source: string | null;
  parent_contact_id: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Postgres returns jsonb_build_object/jsonb_agg directly as JS values via the
 * Bun sql client, so DbContact rows enriched with parent_data + members_data
 * already have ContactRef-shaped objects (no row-mapping pass needed).
 */
type DbContactWithRelations = DbContact & {
  parent_data: ContactRef | null;
  members_data: ContactRef[];
  tags_data: ContactTag[];
};

type DbEmail = {
  id: string;
  contact_id: string;
  label: string | null;
  email: string;
  position: number;
  created_at: Date;
  updated_at: Date;
};

type DbPhone = {
  id: string;
  contact_id: string;
  label: string | null;
  phone: string;
  position: number;
  created_at: Date;
  updated_at: Date;
};

type DbAddress = {
  id: string;
  contact_id: string;
  label: string | null;
  recipient_name: string | null;
  company_name: string | null;
  line1: string;
  line2: string | null;
  postal_code: string;
  city: string;
  state_region: string | null;
  country_code: string;
  position: number;
  created_at: Date;
  updated_at: Date;
};

type DbWebsite = {
  id: string;
  contact_id: string;
  label: string | null;
  url: string;
  position: number;
  created_at: Date;
  updated_at: Date;
};

type DbBankAccount = {
  id: string;
  contact_id: string;
  label: string | null;
  account_holder_name: string;
  iban: string;
  bic: string | null;
  bank_name: string | null;
  note: string | null;
  position: number;
  created_at: Date;
  updated_at: Date;
};

type SearchRow = {
  contact_id: string;
  book_id: string;
};

type ContactCollectionInput = {
  emails?: ContactEmailInput[];
  phones?: ContactPhoneInput[];
  addresses?: ContactAddressInput[];
  websites?: ContactWebsiteInput[];
  bankAccounts?: ContactBankAccountInput[];
  tagIds?: string[];
};

type ContactWritePreparation = {
  parentContactId: string | null;
  tagIds: string[] | null;
};

type ContactCreateFields = {
  label: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  department: string | null;
  jobTitle: string | null;
  vatId: string | null;
  birthday: string | null;
  source: string;
  salutation: string | null;
  pronouns: string | null;
  preferredLanguage: string | null;
};

/**
 * Converts one manual contact row into API shape with supplied child rows.
 * Parent + members are resolved on the DB side (single query) and passed in.
 */
const mapContact = (config: {
  row: DbContactWithRelations;
  emails: ContactEmail[];
  phones: ContactPhone[];
  addresses: ContactAddress[];
  websites: ContactWebsite[];
  bankAccounts: ContactBankAccount[];
}): Contact => ({
  id: config.row.id,
  bookId: config.row.book_id,
  label: config.row.label,
  firstName: config.row.first_name,
  lastName: config.row.last_name,
  companyName: config.row.company_name,
  department: config.row.department,
  jobTitle: config.row.job_title,
  vatId: config.row.vat_id,
  birthday: toDateOnly(config.row.birthday),
  salutation: config.row.salutation,
  pronouns: config.row.pronouns,
  preferredLanguage: config.row.preferred_language,
  source: config.row.source,
  createdAt: config.row.created_at.toISOString(),
  updatedAt: config.row.updated_at.toISOString(),
  emails: config.emails,
  phones: config.phones,
  addresses: config.addresses,
  websites: config.websites,
  bankAccounts: config.bankAccounts,
  parentContactId: config.row.parent_contact_id,
  parent: config.row.parent_data,
  members: config.row.members_data,
  tags: config.row.tags_data,
});

const mapEmail = (row: DbEmail): ContactEmail => ({
  id: row.id,
  contactId: row.contact_id,
  label: row.label,
  email: row.email,
  position: row.position,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapPhone = (row: DbPhone): ContactPhone => ({
  id: row.id,
  contactId: row.contact_id,
  label: row.label,
  phone: row.phone,
  position: row.position,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapAddress = (row: DbAddress): ContactAddress => ({
  id: row.id,
  contactId: row.contact_id,
  label: row.label,
  recipientName: row.recipient_name,
  companyName: row.company_name,
  line1: row.line1,
  line2: row.line2,
  postalCode: row.postal_code,
  city: row.city,
  stateRegion: row.state_region,
  countryCode: row.country_code,
  position: row.position,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapWebsite = (row: DbWebsite): ContactWebsite => ({
  id: row.id,
  contactId: row.contact_id,
  label: row.label,
  url: row.url,
  position: row.position,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapBankAccount = (row: DbBankAccount): ContactBankAccount => ({
  id: row.id,
  contactId: row.contact_id,
  label: row.label,
  accountHolderName: row.account_holder_name,
  iban: row.iban,
  bic: row.bic,
  bankName: row.bank_name,
  note: row.note,
  position: row.position,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const buildSearchPattern = (query: string | undefined): string | null => {
  const trimmed = query?.trim().toLowerCase();
  if (!trimmed) return null;
  return `%${trimmed}%`;
};

const loadEmails = async (contactIds: string[]): Promise<Map<string, ContactEmail[]>> => {
  const validIds = contactIds.filter(isUuid);
  if (validIds.length === 0) return new Map();

  const rows = await sql<DbEmail[]>`
    SELECT id, contact_id, label, email, position, created_at, updated_at
    FROM contacts.contact_emails
    WHERE contact_id = ANY(${toPgUuidArray(validIds)}::uuid[])
    ORDER BY position ASC, created_at ASC
  `;

  const grouped = new Map<string, ContactEmail[]>();
  for (const row of rows) {
    grouped.set(row.contact_id, [...(grouped.get(row.contact_id) ?? []), mapEmail(row)]);
  }
  return grouped;
};

const loadPhones = async (contactIds: string[]): Promise<Map<string, ContactPhone[]>> => {
  const validIds = contactIds.filter(isUuid);
  if (validIds.length === 0) return new Map();

  const rows = await sql<DbPhone[]>`
    SELECT id, contact_id, label, phone, position, created_at, updated_at
    FROM contacts.contact_phones
    WHERE contact_id = ANY(${toPgUuidArray(validIds)}::uuid[])
    ORDER BY position ASC, created_at ASC
  `;

  const grouped = new Map<string, ContactPhone[]>();
  for (const row of rows) {
    grouped.set(row.contact_id, [...(grouped.get(row.contact_id) ?? []), mapPhone(row)]);
  }
  return grouped;
};

const loadAddresses = async (contactIds: string[]): Promise<Map<string, ContactAddress[]>> => {
  const validIds = contactIds.filter(isUuid);
  if (validIds.length === 0) return new Map();

  const rows = await sql<DbAddress[]>`
    SELECT
      id,
      contact_id,
      label,
      recipient_name,
      company_name,
      line1,
      line2,
      postal_code,
      city,
      state_region,
      country_code,
      position,
      created_at,
      updated_at
    FROM contacts.contact_addresses
    WHERE contact_id = ANY(${toPgUuidArray(validIds)}::uuid[])
    ORDER BY position ASC, created_at ASC
  `;

  const grouped = new Map<string, ContactAddress[]>();
  for (const row of rows) {
    grouped.set(row.contact_id, [...(grouped.get(row.contact_id) ?? []), mapAddress(row)]);
  }
  return grouped;
};

const loadWebsites = async (contactIds: string[]): Promise<Map<string, ContactWebsite[]>> => {
  const validIds = contactIds.filter(isUuid);
  if (validIds.length === 0) return new Map();

  const rows = await sql<DbWebsite[]>`
    SELECT id, contact_id, label, url, position, created_at, updated_at
    FROM contacts.contact_websites
    WHERE contact_id = ANY(${toPgUuidArray(validIds)}::uuid[])
    ORDER BY position ASC, created_at ASC
  `;

  const grouped = new Map<string, ContactWebsite[]>();
  for (const row of rows) {
    grouped.set(row.contact_id, [...(grouped.get(row.contact_id) ?? []), mapWebsite(row)]);
  }
  return grouped;
};

const loadBankAccounts = async (contactIds: string[]): Promise<Map<string, ContactBankAccount[]>> => {
  const validIds = contactIds.filter(isUuid);
  if (validIds.length === 0) return new Map();

  const rows = await sql<DbBankAccount[]>`
    SELECT id, contact_id, label, account_holder_name, iban, bic, bank_name, note, position, created_at, updated_at
    FROM contacts.contact_bank_accounts
    WHERE contact_id = ANY(${toPgUuidArray(validIds)}::uuid[])
    ORDER BY position ASC, created_at ASC
  `;

  const grouped = new Map<string, ContactBankAccount[]>();
  for (const row of rows) {
    grouped.set(row.contact_id, [...(grouped.get(row.contact_id) ?? []), mapBankAccount(row)]);
  }
  return grouped;
};

/**
 * Loads manual contacts by IDs and hydrates all child subtables.
 */
/**
 * Loads a set of contacts with hierarchy and child collections fully resolved.
 *
 * Hierarchy (parent + members) is loaded inline via JSON aggregation in the
 * main query — one round-trip regardless of how many contacts are requested.
 * The UI consumes only one hop up and one hop down; deeper traversal happens
 * by navigating into the relevant contact.
 *
 * Emails / phones / addresses keep their batched loaders because they live in
 * separate child tables and are already efficient.
 */
const getManualContactsByIds = async (ids: string[]): Promise<Map<string, Contact>> => {
  const validIds = ids.filter(isUuid);
  if (validIds.length === 0) return new Map();

  const rows = await sql<DbContactWithRelations[]>`
    SELECT
      c.id,
      c.book_id,
      c.label,
      c.first_name,
      c.last_name,
      c.company_name,
      c.department,
      c.job_title,
      c.vat_id,
      c.birthday,
      c.salutation,
      c.pronouns,
      c.preferred_language,
      c.source,
      c.parent_contact_id,
      c.created_at,
      c.updated_at,
      (
        SELECT jsonb_build_object(
          'id', p.id,
          'label', p.label,
          'firstName', p.first_name,
          'lastName', p.last_name,
          'companyName', p.company_name,
          'jobTitle', p.job_title
        )
        FROM contacts.contacts p
        WHERE p.id = c.parent_contact_id
          AND p.book_id = c.book_id
      ) AS parent_data,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', m.id,
              'label', m.label,
              'firstName', m.first_name,
              'lastName', m.last_name,
              'companyName', m.company_name,
              'jobTitle', m.job_title
            )
            ORDER BY COALESCE(m.label, m.first_name, m.last_name, m.company_name, m.id::text)
          )
          FROM contacts.contacts m
          WHERE m.parent_contact_id = c.id
            AND m.book_id = c.book_id
        ),
        '[]'::jsonb
      ) AS members_data,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', t.id,
              'bookId', t.book_id,
              'name', t.name,
              'color', t.color,
              'createdAt', to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'updatedAt', to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
            ORDER BY LOWER(t.name)
          )
          FROM contacts.tags t
          JOIN contacts.contact_tag_assignments cta ON cta.tag_id = t.id
          WHERE cta.contact_id = c.id
        ),
        '[]'::jsonb
      ) AS tags_data
    FROM contacts.contacts c
    WHERE c.id = ANY(${toPgUuidArray(validIds)}::uuid[])
  `;

  const contactIds = rows.map((row) => row.id);
  const [emailsByContact, phonesByContact, addressesByContact, websitesByContact, bankAccountsByContact] = await Promise.all([
    loadEmails(contactIds),
    loadPhones(contactIds),
    loadAddresses(contactIds),
    loadWebsites(contactIds),
    loadBankAccounts(contactIds),
  ]);

  const mapped = new Map<string, Contact>();
  for (const row of rows) {
    mapped.set(
      row.id,
      mapContact({
        row,
        emails: emailsByContact.get(row.id) ?? [],
        phones: phonesByContact.get(row.id) ?? [],
        addresses: addressesByContact.get(row.id) ?? [],
        websites: websitesByContact.get(row.id) ?? [],
        bankAccounts: bankAccountsByContact.get(row.id) ?? [],
      }),
    );
  }

  return mapped;
};

const replaceEmails = async (contactId: string, emails: ContactEmailInput[], db: SqlExecutor = sql): Promise<void> => {
  await db`
    DELETE FROM contacts.contact_emails
    WHERE contact_id = ${contactId}::uuid
  `;

  for (const [index, email] of emails.entries()) {
    await db`
      INSERT INTO contacts.contact_emails (
        contact_id,
        label,
        email,
        position
      ) VALUES (
        ${contactId}::uuid,
        ${emptyToNull(email.label) ?? null},
        ${email.email.trim()},
        ${index}
      )
    `;
  }
};

const replacePhones = async (contactId: string, phones: ContactPhoneInput[], db: SqlExecutor = sql): Promise<void> => {
  await db`
    DELETE FROM contacts.contact_phones
    WHERE contact_id = ${contactId}::uuid
  `;

  for (const [index, phone] of phones.entries()) {
    await db`
      INSERT INTO contacts.contact_phones (
        contact_id,
        label,
        phone,
        position
      ) VALUES (
        ${contactId}::uuid,
        ${emptyToNull(phone.label) ?? null},
        ${phone.phone.trim()},
        ${index}
      )
    `;
  }
};

const replaceAddresses = async (contactId: string, addresses: ContactAddressInput[], db: SqlExecutor = sql): Promise<void> => {
  await db`
    DELETE FROM contacts.contact_addresses
    WHERE contact_id = ${contactId}::uuid
  `;

  for (const [index, address] of addresses.entries()) {
    await db`
      INSERT INTO contacts.contact_addresses (
        contact_id,
        label,
        recipient_name,
        company_name,
        line1,
        line2,
        postal_code,
        city,
        state_region,
        country_code,
        position
      ) VALUES (
        ${contactId}::uuid,
        ${emptyToNull(address.label) ?? null},
        ${emptyToNull(address.recipientName) ?? null},
        ${emptyToNull(address.companyName) ?? null},
        ${address.line1.trim()},
        ${emptyToNull(address.line2) ?? null},
        ${address.postalCode.trim()},
        ${address.city.trim()},
        ${emptyToNull(address.stateRegion) ?? null},
        ${address.countryCode.trim().toUpperCase()},
        ${index}
      )
    `;
  }
};

const replaceWebsites = async (contactId: string, websites: ContactWebsiteInput[], db: SqlExecutor = sql): Promise<void> => {
  await db`
    DELETE FROM contacts.contact_websites
    WHERE contact_id = ${contactId}::uuid
  `;

  for (const [index, website] of websites.entries()) {
    await db`
      INSERT INTO contacts.contact_websites (contact_id, label, url, position)
      VALUES (
        ${contactId}::uuid,
        ${emptyToNull(website.label) ?? null},
        ${website.url.trim()},
        ${index}
      )
    `;
  }
};

const replaceBankAccounts = async (contactId: string, bankAccounts: ContactBankAccountInput[], db: SqlExecutor = sql): Promise<void> => {
  await db`
    DELETE FROM contacts.contact_bank_accounts
    WHERE contact_id = ${contactId}::uuid
  `;

  for (const [index, account] of bankAccounts.entries()) {
    await db`
      INSERT INTO contacts.contact_bank_accounts (
        contact_id,
        label,
        account_holder_name,
        iban,
        bic,
        bank_name,
        note,
        position
      ) VALUES (
        ${contactId}::uuid,
        ${emptyToNull(account.label) ?? null},
        ${account.accountHolderName.trim()},
        ${account.iban.trim().replaceAll(" ", "").toUpperCase()},
        ${emptyToNull(account.bic)?.replaceAll(" ", "").toUpperCase() ?? null},
        ${emptyToNull(account.bankName) ?? null},
        ${emptyToNull(account.note) ?? null},
        ${index}
      )
    `;
  }
};

const mapManualSearchCondition = (searchPattern: string | null) => sql`
  (
    ${searchPattern}::text IS NULL
    OR LOWER(COALESCE(c.label, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(c.first_name, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(c.last_name, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(c.company_name, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(c.department, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(c.job_title, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(c.vat_id, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(c.salutation, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(c.pronouns, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(c.preferred_language, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(ce.email, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(cp.phone, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(ca.line1, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(ca.postal_code, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(ca.city, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(cba.account_holder_name, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(cba.iban, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(cba.bic, '')) LIKE ${searchPattern}
    OR LOWER(COALESCE(cba.bank_name, '')) LIKE ${searchPattern}
  )
`;

const mapManualReadableAccessCondition = (subject: AccessSubject) => {
  const principalMatch = buildAccessPrincipalCondition({
    subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });

  return sql`
  a.permission IN ('read'::auth.permission_level, 'write'::auth.permission_level, 'admin'::auth.permission_level)
  AND ${principalMatch}
`;
};

const validateContactTagIds = async (bookId: string, tagIds: string[] | undefined): Promise<Result<string[] | null>> => {
  if (tagIds === undefined) return ok(null);
  const tagResult = await tags.validateTagsInBook({ bookId, tagIds });
  if (!tagResult.ok) return tagResult;
  return ok(tagResult.data);
};

const buildCreateLabel = (data: CreateContactInput): string | null =>
  resolveStoredContactLabel({
    label: data.label,
    firstName: data.firstName,
    lastName: data.lastName,
    companyName: data.companyName,
    emails: data.emails,
    phones: data.phones,
  });

const buildUpdateLabel = (existing: DbContact, data: UpdateContactInput): string | null =>
  resolveStoredContactLabel({
    label: data.label === undefined ? existing.label : data.label,
    firstName: data.firstName === undefined ? existing.first_name : data.firstName,
    lastName: data.lastName === undefined ? existing.last_name : data.lastName,
    companyName: data.companyName === undefined ? existing.company_name : data.companyName,
  });

const optionalText = (existing: string | null, next: string | null | undefined): string | null =>
  next === undefined ? existing : emptyToNull(next);

const optionalBirthday = (existing: Date | string | null, next: string | null | undefined): string | null =>
  next === undefined ? toDateOnly(existing) : next;

const buildCreateFields = (data: CreateContactInput): ContactCreateFields => ({
  label: buildCreateLabel(data),
  firstName: emptyToNull(data.firstName) ?? null,
  lastName: emptyToNull(data.lastName) ?? null,
  companyName: emptyToNull(data.companyName) ?? null,
  department: emptyToNull(data.department) ?? null,
  jobTitle: emptyToNull(data.jobTitle) ?? null,
  vatId: emptyToNull(data.vatId) ?? null,
  birthday: data.birthday ?? null,
  source: emptyToNull(data.source) ?? "manual",
  salutation: emptyToNull(data.salutation) ?? null,
  pronouns: emptyToNull(data.pronouns) ?? null,
  preferredLanguage: emptyToNull(data.preferredLanguage) ?? null,
});

const prepareContactCreate = async (config: { bookId: string; data: CreateContactInput }): Promise<Result<ContactWritePreparation>> => {
  const parentResult = await resolveParentContactId({
    contactId: null,
    bookId: config.bookId,
    desiredParentId: config.data.parentContactId,
  });
  if (!parentResult.ok) return parentResult;

  const tagResult = await validateContactTagIds(config.bookId, config.data.tagIds);
  if (!tagResult.ok) return tagResult;

  return ok({ parentContactId: parentResult.data, tagIds: tagResult.data });
};

const prepareContactUpdate = async (config: {
  bookId: string;
  contactId: string;
  existingParentContactId: string | null;
  data: UpdateContactInput;
}): Promise<Result<ContactWritePreparation>> => {
  let parentContactId = config.existingParentContactId;
  if (config.data.parentContactId !== undefined) {
    const parentResult = await resolveParentContactId({
      contactId: config.contactId,
      bookId: config.bookId,
      desiredParentId: config.data.parentContactId,
    });
    if (!parentResult.ok) return parentResult;
    parentContactId = parentResult.data;
  }

  const tagResult = await validateContactTagIds(config.bookId, config.data.tagIds);
  if (!tagResult.ok) return tagResult;

  return ok({ parentContactId, tagIds: tagResult.data });
};

const replaceContactCollections = async (contactId: string, data: ContactCollectionInput, db: SqlExecutor = sql): Promise<void> => {
  if (data.emails !== undefined) {
    await replaceEmails(contactId, data.emails, db);
  }
  if (data.phones !== undefined) {
    await replacePhones(contactId, data.phones, db);
  }
  if (data.addresses !== undefined) {
    await replaceAddresses(contactId, data.addresses, db);
  }
  if (data.websites !== undefined) {
    await replaceWebsites(contactId, data.websites, db);
  }
  if (data.bankAccounts !== undefined) {
    await replaceBankAccounts(contactId, data.bankAccounts, db);
  }
};

const loadWrittenContact = async (config: { bookId: string; id: string; action: "created" | "updated" }): Promise<Result<Contact>> => {
  const contact = await get({ bookId: config.bookId, id: config.id });
  if (!contact) return fail(err.internal(`Failed to load ${config.action} contact`));
  return ok(contact);
};

/**
 * Resolves a desired `parentContactId` against book + cycle rules.
 *
 * Returns:
 *  - `ok(null)` when the caller wants to clear the parent (input is null/empty)
 *  - `ok(uuid)` when the parent is valid and may be persisted
 *  - `fail(err.invalid…)` for self-reference / cross-book / cycle / missing
 *
 * `contactId` is the contact whose parent is being set. Pass `null` for
 * create flows where the contact does not yet exist (no cycle is possible).
 */
const resolveParentContactId = async (config: {
  contactId: string | null;
  bookId: string;
  desiredParentId: string | null | undefined;
}): Promise<Result<string | null>> => {
  const desired = emptyToNull(config.desiredParentId ?? null);
  if (desired === null) return ok(null);

  if (!isUuid(desired)) return fail(err.badInput("Parent contact id must be a UUID"));
  if (config.contactId !== null && desired === config.contactId) {
    return fail(err.badInput("A contact cannot be its own parent"));
  }

  const [parentRow] = await sql<{ book_id: string }[]>`
    SELECT book_id FROM contacts.contacts WHERE id = ${desired}::uuid
  `;
  if (!parentRow) return fail(err.badInput("Parent contact does not exist"));
  if (parentRow.book_id !== config.bookId) {
    return fail(err.badInput("Parent must live in the same book"));
  }

  if (config.contactId !== null) {
    // Walk the desired parent's ancestor chain. If we hit `contactId`, accepting
    // would create a cycle (contactId is already an ancestor of desired).
    const [cycle] = await sql<{ exists: boolean }[]>`
      WITH RECURSIVE up AS (
        SELECT id, parent_contact_id
        FROM contacts.contacts
        WHERE id = ${desired}::uuid
        UNION ALL
        SELECT c.id, c.parent_contact_id
        FROM contacts.contacts c
        JOIN up ON c.id = up.parent_contact_id
      )
      SELECT EXISTS (SELECT 1 FROM up WHERE id = ${config.contactId}::uuid) AS "exists"
    `;
    if (cycle?.exists) {
      return fail(err.badInput("Cannot create a hierarchy cycle"));
    }
  }

  return ok(desired);
};

/**
 * Lists contacts for one persisted book.
 */
export const list = async (config: {
  bookId: string;
  pagination?: PageParams;
  filter?: ContactListFilter;
}): Promise<Paginated<Contact>> => {
  if (!isUuid(config.bookId)) {
    return {
      items: [],
      page: config.pagination?.page ?? 1,
      perPage: config.pagination?.perPage ?? 20,
      total: 0,
      hasNext: false,
    };
  }

  const searchPattern = buildSearchPattern(config.filter?.query);
  const { page, perPage, offset } = paginate(config.pagination);
  const requestedFavoriteUserId = config.filter?.favoriteUserId;
  if (requestedFavoriteUserId !== undefined && !isUuid(requestedFavoriteUserId)) {
    return { items: [], page, perPage, total: 0, hasNext: false };
  }
  const filterTagIds = (config.filter?.tagIds ?? []).filter(isUuid);
  const tagIdsArray = filterTagIds.length > 0 ? toPgUuidArray(filterTagIds) : null;
  const emailPresence = config.filter?.email ?? "all";
  const phonePresence = config.filter?.phone ?? "all";
  const sort = config.filter?.sort ?? "name";
  const favoriteUserId = requestedFavoriteUserId ?? null;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(DISTINCT c.id)::int AS count
    FROM contacts.contacts c
    LEFT JOIN contacts.contact_emails ce ON ce.contact_id = c.id
    LEFT JOIN contacts.contact_phones cp ON cp.contact_id = c.id
    LEFT JOIN contacts.contact_addresses ca ON ca.contact_id = c.id
    LEFT JOIN contacts.contact_bank_accounts cba ON cba.contact_id = c.id
    WHERE c.book_id = ${config.bookId}::uuid
      AND ${mapManualSearchCondition(searchPattern)}
      AND (${tagIdsArray}::uuid[] IS NULL OR EXISTS (
        SELECT 1 FROM contacts.contact_tag_assignments cta
        WHERE cta.contact_id = c.id AND cta.tag_id = ANY(${tagIdsArray}::uuid[])
      ))
      AND (${favoriteUserId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM contacts.contact_favorites favorite
        WHERE favorite.user_id = ${favoriteUserId}::uuid
          AND favorite.book_id = ${config.bookId}
          AND favorite.contact_id = c.id
      ))
      AND (${emailPresence} = 'all' OR (${emailPresence} = 'yes' AND EXISTS (
        SELECT 1 FROM contacts.contact_emails email_filter WHERE email_filter.contact_id = c.id
      )) OR (${emailPresence} = 'no' AND NOT EXISTS (
        SELECT 1 FROM contacts.contact_emails email_filter WHERE email_filter.contact_id = c.id
      )))
      AND (${phonePresence} = 'all' OR (${phonePresence} = 'yes' AND EXISTS (
        SELECT 1 FROM contacts.contact_phones phone_filter WHERE phone_filter.contact_id = c.id
      )) OR (${phonePresence} = 'no' AND NOT EXISTS (
        SELECT 1 FROM contacts.contact_phones phone_filter WHERE phone_filter.contact_id = c.id
      )))
  `;

  // The list query only needs IDs (in sorted order) — full contact rows are
  // hydrated by getManualContactsByIds, which loads parent + members + child
  // collections in one batched pass.
  const rows = await sql<{ id: string }[]>`
    WITH matches AS (
      SELECT DISTINCT
        c.id,
        LOWER(
          COALESCE(
            NULLIF(c.label, ''),
            NULLIF(TRIM(CONCAT_WS(' ', COALESCE(c.first_name, ''), COALESCE(c.last_name, ''))), ''),
            NULLIF(c.company_name, ''),
            ''
          )
        ) AS sort_name,
        c.created_at,
        c.updated_at,
        LOWER(NULLIF(TRIM(c.company_name), '')) AS sort_company
      FROM contacts.contacts c
      LEFT JOIN contacts.contact_emails ce ON ce.contact_id = c.id
      LEFT JOIN contacts.contact_phones cp ON cp.contact_id = c.id
      LEFT JOIN contacts.contact_addresses ca ON ca.contact_id = c.id
      LEFT JOIN contacts.contact_bank_accounts cba ON cba.contact_id = c.id
      WHERE c.book_id = ${config.bookId}::uuid
        AND ${mapManualSearchCondition(searchPattern)}
        AND (${tagIdsArray}::uuid[] IS NULL OR EXISTS (
          SELECT 1 FROM contacts.contact_tag_assignments cta
          WHERE cta.contact_id = c.id AND cta.tag_id = ANY(${tagIdsArray}::uuid[])
        ))
        AND (${favoriteUserId}::uuid IS NULL OR EXISTS (
          SELECT 1 FROM contacts.contact_favorites favorite
          WHERE favorite.user_id = ${favoriteUserId}::uuid
            AND favorite.book_id = ${config.bookId}
            AND favorite.contact_id = c.id
        ))
        AND (${emailPresence} = 'all' OR (${emailPresence} = 'yes' AND EXISTS (
          SELECT 1 FROM contacts.contact_emails email_filter WHERE email_filter.contact_id = c.id
        )) OR (${emailPresence} = 'no' AND NOT EXISTS (
          SELECT 1 FROM contacts.contact_emails email_filter WHERE email_filter.contact_id = c.id
        )))
        AND (${phonePresence} = 'all' OR (${phonePresence} = 'yes' AND EXISTS (
          SELECT 1 FROM contacts.contact_phones phone_filter WHERE phone_filter.contact_id = c.id
        )) OR (${phonePresence} = 'no' AND NOT EXISTS (
          SELECT 1 FROM contacts.contact_phones phone_filter WHERE phone_filter.contact_id = c.id
        )))
    )
    SELECT id
    FROM matches
    ORDER BY
      CASE WHEN ${sort} = 'updated' THEN updated_at END DESC,
      CASE WHEN ${sort} = 'created' THEN created_at END DESC,
      CASE WHEN ${sort} = 'company' THEN sort_company END ASC NULLS LAST,
      sort_name ASC,
      id ASC
    LIMIT ${perPage}
    OFFSET ${offset}
  `;

  const mapped = await getManualContactsByIds(rows.map((row) => row.id));
  const items = rows.map((row) => mapped.get(row.id) ?? null).filter((row): row is Contact => row !== null);

  const total = countRow?.count ?? 0;
  return {
    items,
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};

/**
 * Returns one contact from one specific book.
 */
export const get = async (config: { bookId: string; id: string }): Promise<Contact | null> => {
  if (!isUuid(config.bookId) || !isUuid(config.id)) return null;

  const mapped = await getManualContactsByIds([config.id]);
  const contact = mapped.get(config.id);
  if (!contact || contact.bookId !== config.bookId) return null;
  return contact;
};

/** Resolves the owning manual book for a stable contact id. */
export const findBookId = async (config: { id: string }): Promise<string | null> => {
  if (!isUuid(config.id)) return null;
  const [row] = await sql<{ book_id: string }[]>`
    SELECT book_id FROM contacts.contacts WHERE id = ${config.id}::uuid
  `;
  return row?.book_id ?? null;
};

/**
 * Loads the full manual-book hierarchy around a selected contact.
 *
 * The root is the selected contact's top-most ancestor in the same book; all
 * descendants of that root are returned so the detail panel does not depend on
 * the currently paginated contact list.
 */
export const tree = async (config: { bookId: string; id: string }): Promise<ContactTree | null> => {
  if (!isUuid(config.bookId) || !isUuid(config.id)) return null;

  const rows = await sql<ContactTreeRow[]>`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_contact_id, ARRAY[id] AS path
      FROM contacts.contacts
      WHERE id = ${config.id}::uuid
        AND book_id = ${config.bookId}::uuid

      UNION ALL

      SELECT parent.id, parent.parent_contact_id, child.path || parent.id
      FROM contacts.contacts parent
      JOIN ancestors child ON child.parent_contact_id = parent.id
      WHERE parent.book_id = ${config.bookId}::uuid
        AND NOT parent.id = ANY(child.path)
    ),
    root AS (
      SELECT id
      FROM ancestors
      WHERE parent_contact_id IS NULL
      LIMIT 1
    ),
    descendants AS (
      SELECT
        c.id,
        c.label,
        c.first_name,
        c.last_name,
        c.company_name,
        c.job_title,
        c.parent_contact_id,
        0 AS depth,
        ARRAY[c.id] AS path
      FROM contacts.contacts c
      WHERE c.id = (SELECT id FROM root)
        AND c.book_id = ${config.bookId}::uuid

      UNION ALL

      SELECT
        child.id,
        child.label,
        child.first_name,
        child.last_name,
        child.company_name,
        child.job_title,
        child.parent_contact_id,
        descendants.depth + 1 AS depth,
        descendants.path || child.id
      FROM contacts.contacts child
      JOIN descendants ON child.parent_contact_id = descendants.id
      WHERE child.book_id = ${config.bookId}::uuid
        AND NOT child.id = ANY(descendants.path)
    )
    SELECT
      id,
      label,
      first_name,
      last_name,
      company_name,
      job_title,
      parent_contact_id
    FROM descendants
  `;

  return buildContactTree({ bookId: config.bookId, selectedId: config.id, rows });
};

/**
 * Creates one manual contact and all optional child entries.
 */
export const create = async (config: { bookId: string; data: CreateContactInput }): Promise<Result<Contact>> => {
  if (!isUuid(config.bookId)) return fail(err.notFound("Book"));

  const fields = buildCreateFields(config.data);

  // Validate parent + tags BEFORE inserting the contact row. Anything that
  // can fail because of bad input must be caught here so we never persist a
  // contact that ends up half-set-up.
  const prepared = await prepareContactCreate({ bookId: config.bookId, data: config.data });
  if (!prepared.ok) return prepared;

  const row = await withShortIdRetry(["contact"], () =>
    sql.begin(async (tx): Promise<{ id: string } | null> => {
      const shortId = newShortId();
      const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO contacts.contacts (
        short_id,
        book_id,
        label,
        first_name,
        last_name,
        company_name,
        department,
        job_title,
        vat_id,
        birthday,
        source,
        salutation,
        pronouns,
        preferred_language,
        parent_contact_id
      ) VALUES (
        ${shortId},
        ${config.bookId}::uuid,
        ${fields.label},
        ${fields.firstName},
        ${fields.lastName},
        ${fields.companyName},
        ${fields.department},
        ${fields.jobTitle},
        ${fields.vatId},
        ${fields.birthday},
        ${fields.source},
        ${fields.salutation},
        ${fields.pronouns},
        ${fields.preferredLanguage},
        ${prepared.data.parentContactId}
      )
      RETURNING id
    `;

      if (!inserted) return null;

      await replaceContactCollections(
        inserted.id,
        {
          emails: config.data.emails ?? [],
          phones: config.data.phones ?? [],
          addresses: config.data.addresses ?? [],
          websites: config.data.websites ?? [],
          bankAccounts: config.data.bankAccounts ?? [],
        },
        tx,
      );
      if (prepared.data.tagIds !== null) {
        await tags.replaceAssignments({ contactId: inserted.id, tagIds: prepared.data.tagIds, db: tx });
      }
      return inserted;
    }),
  );

  if (!row) return fail(err.internal("Failed to create contact"));

  return loadWrittenContact({ bookId: config.bookId, id: row.id, action: "created" });
};

/**
 * Creates a contact exactly once for one actor/action/idempotency tuple.
 * The claim and contact row commit in the same transaction, so a process crash
 * cannot leave a successful effect without its replay record.
 */
export const createIdempotent = async (config: {
  bookId: string;
  data: CreateContactInput;
  actorKey: string;
  actionId: string;
  idempotencyKeyHash: string;
  requestHash: string;
}): Promise<Result<{ id: string; bookId: string; label: string; replayed: boolean }>> => {
  if (!isUuid(config.bookId)) return fail(err.notFound("Book"));

  const fields = buildCreateFields(config.data);
  const resultLabel = resolveContactName(config.data);
  const prepared = await prepareContactCreate({ bookId: config.bookId, data: config.data });
  if (!prepared.ok) return prepared;

  const outcome = await withShortIdRetry(["contact"], () =>
    sql.begin(async (tx): Promise<Result<{ contactId: string; resultLabel: string; replayed: boolean }>> => {
      const shortId = newShortId();
      const [allocated] = await tx<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
      if (!allocated) return fail(err.internal("Failed to allocate contact id"));

      const [claim] = await tx<{ contact_id: string }[]>`
      INSERT INTO contacts.capability_action_results (
        actor_key, action_id, idempotency_key_hash, request_hash, contact_id, result_label
      ) VALUES (
        ${config.actorKey}, ${config.actionId}, ${config.idempotencyKeyHash},
        ${config.requestHash}, ${allocated.id}::uuid, ${resultLabel}
      )
      ON CONFLICT (actor_key, action_id, idempotency_key_hash) DO NOTHING
      RETURNING contact_id
    `;
      if (!claim) {
        const [existing] = await tx<{ request_hash: string; contact_id: string; result_label: string | null }[]>`
        SELECT request_hash, contact_id, result_label
        FROM contacts.capability_action_results
        WHERE actor_key = ${config.actorKey}
          AND action_id = ${config.actionId}
          AND idempotency_key_hash = ${config.idempotencyKeyHash}
      `;
        if (!existing) return fail(err.internal("Idempotency replay lookup failed"));
        if (existing.request_hash !== config.requestHash) {
          return fail(capabilityIdempotencyConflict("Idempotency-Key was already used with different input"));
        }
        return ok({ contactId: existing.contact_id, resultLabel: existing.result_label ?? resultLabel, replayed: true });
      }

      const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO contacts.contacts (
        id, short_id, book_id, label, first_name, last_name, company_name, department,
        job_title, vat_id, birthday, source, salutation, pronouns,
        preferred_language, parent_contact_id
      ) VALUES (
        ${allocated.id}::uuid, ${shortId}, ${config.bookId}::uuid, ${fields.label},
        ${fields.firstName}, ${fields.lastName}, ${fields.companyName},
        ${fields.department}, ${fields.jobTitle}, ${fields.vatId},
        ${fields.birthday}, ${fields.source}, ${fields.salutation},
        ${fields.pronouns}, ${fields.preferredLanguage}, ${prepared.data.parentContactId}
      )
      RETURNING id
    `;
      if (!inserted) throw new Error("Failed to create claimed contact");

      await replaceContactCollections(
        inserted.id,
        {
          emails: config.data.emails ?? [],
          phones: config.data.phones ?? [],
          addresses: config.data.addresses ?? [],
          websites: config.data.websites ?? [],
          bankAccounts: config.data.bankAccounts ?? [],
        },
        tx,
      );
      if (prepared.data.tagIds !== null) {
        await tags.replaceAssignments({ contactId: inserted.id, tagIds: prepared.data.tagIds, db: tx });
      }
      return ok({ contactId: inserted.id, resultLabel, replayed: false });
    }),
  );

  if (!outcome.ok) return outcome;
  return ok({
    id: outcome.data.contactId,
    bookId: config.bookId,
    label: outcome.data.resultLabel,
    replayed: outcome.data.replayed,
  });
};

/**
 * Updates one manual contact. Child arrays are fully replaced when provided.
 */
export const update = async (config: {
  bookId: string;
  id: string;
  data: UpdateContactInput;
  expectedUpdatedAt?: string;
}): Promise<Result<Contact>> => {
  if (!isUuid(config.bookId) || !isUuid(config.id)) {
    return fail(err.notFound("Contact"));
  }

  const [existing] = await sql<DbContact[]>`
    SELECT
      id,
      book_id,
      label,
      first_name,
      last_name,
      company_name,
      department,
      job_title,
      vat_id,
      birthday,
      salutation,
      pronouns,
      preferred_language,
      source,
      parent_contact_id,
      created_at,
      updated_at
    FROM contacts.contacts
    WHERE id = ${config.id}::uuid
      AND book_id = ${config.bookId}::uuid
  `;

  if (!existing) return fail(err.notFound("Contact"));
  if (config.expectedUpdatedAt !== undefined && existing.updated_at.toISOString() !== config.expectedUpdatedAt) {
    return fail(err.conflict("Contact changed since it was read"));
  }

  const nextLabel = buildUpdateLabel(existing, config.data);

  const prepared = await prepareContactUpdate({
    bookId: config.bookId,
    contactId: config.id,
    existingParentContactId: existing.parent_contact_id,
    data: config.data,
  });
  if (!prepared.ok) return prepared;

  const row = await sql.begin(async (tx): Promise<{ id: string } | null> => {
    const [updated] = await tx<{ id: string }[]>`
      UPDATE contacts.contacts
      SET
        label = ${nextLabel},
        first_name = ${optionalText(existing.first_name, config.data.firstName)},
        last_name = ${optionalText(existing.last_name, config.data.lastName)},
        company_name = ${optionalText(existing.company_name, config.data.companyName)},
        department = ${optionalText(existing.department, config.data.department)},
        job_title = ${optionalText(existing.job_title, config.data.jobTitle)},
        vat_id = ${optionalText(existing.vat_id, config.data.vatId)},
        birthday = ${optionalBirthday(existing.birthday, config.data.birthday)},
        salutation = ${optionalText(existing.salutation, config.data.salutation)},
        pronouns = ${optionalText(existing.pronouns, config.data.pronouns)},
        preferred_language = ${optionalText(existing.preferred_language, config.data.preferredLanguage)},
        source = ${optionalText(existing.source, config.data.source)},
        parent_contact_id = ${prepared.data.parentContactId},
        updated_at = now()
      WHERE id = ${config.id}::uuid
        AND book_id = ${config.bookId}::uuid
        AND (
          ${config.expectedUpdatedAt ?? null}::timestamptz IS NULL
          OR date_trunc('milliseconds', updated_at) = ${config.expectedUpdatedAt ?? null}::timestamptz
        )
      RETURNING id
    `;

    if (!updated) return null;

    await replaceContactCollections(updated.id, config.data, tx);
    if (prepared.data.tagIds !== null) {
      await tags.replaceAssignments({ contactId: updated.id, tagIds: prepared.data.tagIds, db: tx });
    }
    return updated;
  });

  if (!row) return fail(err.conflict("Contact changed since it was read"));

  return loadWrittenContact({ bookId: config.bookId, id: row.id, action: "updated" });
};

/**
 * Moves one manual contact to another manual book.
 */
export const move = async (config: {
  sourceBookId: string;
  targetBookId: string;
  id: string;
  expectedUpdatedAt?: string;
}): Promise<Result<Contact>> => {
  if (!isUuid(config.sourceBookId) || !isUuid(config.targetBookId) || !isUuid(config.id)) {
    return fail(err.notFound("Contact"));
  }
  if (config.sourceBookId === config.targetBookId) {
    return fail(err.badInput("Choose another contact book"));
  }

  // Move + sever cross-book references in one transaction:
  //   * children's parent_contact_id → NULL (would otherwise span books)
  //   * own parent_contact_id → NULL (same reason)
  //   * own tag assignments → DELETE (tags are book-scoped vocabulary)
  // The user sees a warning in the UI before confirming.
  const row = await sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string; updated_at: Date }[]>`
      SELECT id, updated_at
      FROM contacts.contacts
      WHERE id = ${config.id}::uuid
        AND book_id = ${config.sourceBookId}::uuid
      FOR UPDATE
    `;
    if (!existing) return null;
    if (config.expectedUpdatedAt !== undefined && existing.updated_at.toISOString() !== config.expectedUpdatedAt) {
      return "stale" as const;
    }

    await tx`
      UPDATE contacts.contacts
      SET parent_contact_id = NULL,
          updated_at = now()
      WHERE parent_contact_id = ${config.id}::uuid
        AND book_id = ${config.sourceBookId}::uuid
    `;
    await tx`
      DELETE FROM contacts.contact_tag_assignments
      WHERE contact_id = ${config.id}::uuid
    `;
    await tx`
      INSERT INTO contacts.contact_favorites (user_id, book_id, contact_id, created_at)
      SELECT user_id, ${config.targetBookId}, contact_id, created_at
      FROM contacts.contact_favorites
      WHERE book_id = ${config.sourceBookId}
        AND contact_id = ${config.id}::uuid
      ON CONFLICT (user_id, book_id, contact_id) DO NOTHING
    `;
    await tx`
      DELETE FROM contacts.contact_favorites
      WHERE book_id = ${config.sourceBookId}
        AND contact_id = ${config.id}::uuid
    `;
    const [moved] = await tx<{ id: string }[]>`
      UPDATE contacts.contacts
      SET
        book_id = ${config.targetBookId}::uuid,
        parent_contact_id = NULL,
        updated_at = now()
      WHERE id = ${config.id}::uuid
        AND book_id = ${config.sourceBookId}::uuid
      RETURNING id
    `;
    return moved ?? null;
  });

  if (row === "stale") return fail(err.conflict("Contact changed since it was read"));
  if (!row) return fail(err.notFound("Contact"));

  const moved = await get({ bookId: config.targetBookId, id: row.id });
  if (!moved) return fail(err.internal("Failed to load moved contact"));

  return ok(moved);
};

/**
 * Deletes one contact from one manual book.
 */
export const remove = async (config: { bookId: string; id: string; expectedUpdatedAt?: string }): Promise<Result<void>> => {
  if (!isUuid(config.bookId) || !isUuid(config.id)) {
    return fail(err.notFound("Contact"));
  }

  const result = await sql.begin(async (tx) => {
    const deleted = await tx`
      DELETE FROM contacts.contacts
      WHERE id = ${config.id}::uuid
        AND book_id = ${config.bookId}::uuid
        AND (
          ${config.expectedUpdatedAt ?? null}::timestamptz IS NULL
          OR date_trunc('milliseconds', updated_at) = ${config.expectedUpdatedAt ?? null}::timestamptz
        )
    `;
    if (deleted.count > 0) {
      await tx`
        DELETE FROM contacts.contact_favorites
        WHERE book_id = ${config.bookId}
          AND contact_id = ${config.id}::uuid
      `;
    }
    return deleted;
  });

  if (result.count === 0) {
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM contacts.contacts WHERE id = ${config.id}::uuid AND book_id = ${config.bookId}::uuid
    `;
    return existing && config.expectedUpdatedAt !== undefined
      ? fail(err.conflict("Contact changed since it was read"))
      : fail(err.notFound("Contact"));
  }
  return ok();
};

/** Loads an explicit, ordered subset from one manual book. */
export const getMany = async (config: { bookId: string; ids: string[] }): Promise<Result<Contact[]>> => {
  if (!isUuid(config.bookId)) return fail(err.notFound("Book"));
  const normalized = normalizeContactIds(config.ids);
  if (!normalized.ok) return normalized;

  const contactsById = await getManualContactsByIds(normalized.data);
  const contacts = normalized.data.flatMap((id) => {
    const contact = contactsById.get(id);
    return contact?.bookId === config.bookId ? [contact] : [];
  });
  if (contacts.length !== normalized.data.length) return fail(err.notFound("One or more contacts"));
  return ok(contacts);
};

/** Adds book-scoped tags without replacing existing assignments. */
export const addTags = async (config: { bookId: string; ids: string[]; tagIds: string[] }): Promise<Result<number>> => {
  if (!isUuid(config.bookId)) return fail(err.notFound("Book"));
  const normalized = normalizeContactIds(config.ids);
  if (!normalized.ok) return normalized;
  const validTags = await tags.validateTagsInBook({ bookId: config.bookId, tagIds: config.tagIds });
  if (!validTags.ok) return validTags;
  if (validTags.data.length === 0) return fail(err.badInput("Choose at least one tag"));

  const updated = await sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      SELECT id
      FROM contacts.contacts
      WHERE book_id = ${config.bookId}::uuid
        AND id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
      FOR UPDATE
    `;
    if (rows.length !== normalized.data.length) return 0;
    await tx`
      INSERT INTO contacts.contact_tag_assignments (contact_id, tag_id)
      SELECT contact_id, tag_id
      FROM unnest(${toPgUuidArray(normalized.data)}::uuid[]) AS contact_id
      CROSS JOIN unnest(${toPgUuidArray(validTags.data)}::uuid[]) AS tag_id
      ON CONFLICT DO NOTHING
    `;
    await tx`
      UPDATE contacts.contacts
      SET updated_at = now()
      WHERE id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
    `;
    return rows.length;
  });

  return updated === 0 ? fail(err.notFound("One or more contacts")) : ok(updated);
};

/** Deletes an explicit set atomically; stale selections fail without partial writes. */
export const removeMany = async (config: { bookId: string; ids: string[] }): Promise<Result<number>> => {
  if (!isUuid(config.bookId)) return fail(err.notFound("Book"));
  const normalized = normalizeContactIds(config.ids);
  if (!normalized.ok) return normalized;

  const removed = await sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      SELECT id
      FROM contacts.contacts
      WHERE book_id = ${config.bookId}::uuid
        AND id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
      FOR UPDATE
    `;
    if (rows.length !== normalized.data.length) return 0;
    await tx`
      DELETE FROM contacts.contact_favorites
      WHERE book_id = ${config.bookId}
        AND contact_id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
    `;
    await tx`
      DELETE FROM contacts.contacts
      WHERE book_id = ${config.bookId}::uuid
        AND id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
    `;
    return rows.length;
  });

  return removed === 0 ? fail(err.notFound("One or more contacts")) : ok(removed);
};

/**
 * Moves contacts as one unit. Relationships within the selected set survive;
 * cross-book parents, children, and source-book tags are removed.
 */
export const moveMany = async (config: { sourceBookId: string; targetBookId: string; ids: string[] }): Promise<Result<number>> => {
  if (!isUuid(config.sourceBookId) || !isUuid(config.targetBookId)) return fail(err.notFound("Book"));
  if (config.sourceBookId === config.targetBookId) return fail(err.badInput("Choose another contact book"));
  const normalized = normalizeContactIds(config.ids);
  if (!normalized.ok) return normalized;

  const moved = await sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      SELECT id
      FROM contacts.contacts
      WHERE book_id = ${config.sourceBookId}::uuid
        AND id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
      FOR UPDATE
    `;
    if (rows.length !== normalized.data.length) return 0;

    await tx`
      UPDATE contacts.contacts
      SET parent_contact_id = NULL, updated_at = now()
      WHERE book_id = ${config.sourceBookId}::uuid
        AND parent_contact_id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
        AND id <> ALL(${toPgUuidArray(normalized.data)}::uuid[])
    `;
    await tx`
      UPDATE contacts.contacts
      SET parent_contact_id = NULL
      WHERE id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
        AND parent_contact_id IS NOT NULL
        AND parent_contact_id <> ALL(${toPgUuidArray(normalized.data)}::uuid[])
    `;
    await tx`
      DELETE FROM contacts.contact_tag_assignments
      WHERE contact_id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
    `;
    await tx`
      INSERT INTO contacts.contact_favorites (user_id, book_id, contact_id, created_at)
      SELECT user_id, ${config.targetBookId}, contact_id, created_at
      FROM contacts.contact_favorites
      WHERE book_id = ${config.sourceBookId}
        AND contact_id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
      ON CONFLICT (user_id, book_id, contact_id) DO NOTHING
    `;
    await tx`
      DELETE FROM contacts.contact_favorites
      WHERE book_id = ${config.sourceBookId}
        AND contact_id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
    `;
    await tx`
      UPDATE contacts.contacts
      SET book_id = ${config.targetBookId}::uuid, updated_at = now()
      WHERE id = ANY(${toPgUuidArray(normalized.data)}::uuid[])
    `;
    return rows.length;
  });

  return moved === 0 ? fail(err.notFound("One or more contacts")) : ok(moved);
};

type DuplicatePairRow = {
  first_id: string;
  second_id: string;
  same_email: boolean;
  same_phone: boolean;
  same_name: boolean;
};

const MAX_DUPLICATE_SIGNAL_GROUPS = 500;
const MAX_CONTACTS_PER_DUPLICATE_SIGNAL = 32;

/** Finds a bounded set of exact duplicate candidates inside one book. */
export const findDuplicates = async (config: { bookId: string; limit?: number }): Promise<ContactDuplicateMatch[]> => {
  if (!isUuid(config.bookId)) return [];
  const limit = Math.max(1, Math.min(config.limit ?? 100, 250));
  const rows = await sql<DuplicatePairRow[]>`
    WITH signals AS (
      SELECT 'email'::text AS reason, LOWER(TRIM(e.email)) AS value, e.contact_id, c.updated_at
      FROM contacts.contact_emails e
      JOIN contacts.contacts c ON c.id = e.contact_id
      WHERE c.book_id = ${config.bookId}::uuid AND NULLIF(TRIM(e.email), '') IS NOT NULL
      UNION ALL
      SELECT 'phone'::text, regexp_replace(p.phone, '[^0-9+]', '', 'g'), p.contact_id, c.updated_at
      FROM contacts.contact_phones p
      JOIN contacts.contacts c ON c.id = p.contact_id
      WHERE c.book_id = ${config.bookId}::uuid
        AND length(regexp_replace(p.phone, '[^0-9]', '', 'g')) >= 6
      UNION ALL
      SELECT
        'name'::text,
        LOWER(COALESCE(NULLIF(TRIM(c.label), ''), NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), NULLIF(TRIM(c.company_name), ''))),
        c.id,
        c.updated_at
      FROM contacts.contacts c
      WHERE c.book_id = ${config.bookId}::uuid
        AND COALESCE(NULLIF(TRIM(c.label), ''), NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), NULLIF(TRIM(c.company_name), '')) IS NOT NULL
    ), duplicate_signal_values AS (
      SELECT reason, value, MAX(updated_at) AS latest_update
      FROM signals
      GROUP BY reason, value
      HAVING COUNT(DISTINCT contact_id) > 1
      ORDER BY latest_update DESC
      LIMIT ${MAX_DUPLICATE_SIGNAL_GROUPS}
    ), ranked_signals AS (
      SELECT
        signal.reason,
        signal.value,
        signal.contact_id,
        ROW_NUMBER() OVER (PARTITION BY signal.reason, signal.value ORDER BY signal.contact_id) AS signal_rank
      FROM (
        SELECT DISTINCT reason, value, contact_id
        FROM signals
      ) signal
      JOIN duplicate_signal_values duplicate
        ON duplicate.reason = signal.reason AND duplicate.value = signal.value
    ), bounded_signals AS (
      SELECT reason, value, contact_id
      FROM ranked_signals
      WHERE signal_rank <= ${MAX_CONTACTS_PER_DUPLICATE_SIGNAL}
    ), pairs AS (
      SELECT
        first.contact_id AS first_id,
        second.contact_id AS second_id,
        BOOL_OR(first.reason = 'email') AS same_email,
        BOOL_OR(first.reason = 'phone') AS same_phone,
        BOOL_OR(first.reason = 'name') AS same_name
      FROM bounded_signals first
      JOIN bounded_signals second
        ON second.reason = first.reason
        AND second.value = first.value
        AND second.contact_id > first.contact_id
      GROUP BY first.contact_id, second.contact_id
    )
    SELECT
      pairs.first_id,
      pairs.second_id,
      pairs.same_email,
      pairs.same_phone,
      pairs.same_name
    FROM pairs
    JOIN contacts.contacts first_contact ON first_contact.id = pairs.first_id
    JOIN contacts.contacts second_contact ON second_contact.id = pairs.second_id
    ORDER BY first_contact.updated_at DESC, second_contact.updated_at DESC
    LIMIT ${limit}
  `;
  const contactsById = await getManualContactsByIds(rows.flatMap((row) => [row.first_id, row.second_id]));
  return rows.flatMap((row) => {
    const first = contactsById.get(row.first_id);
    const second = contactsById.get(row.second_id);
    if (!first || !second) return [];
    const reasons: ContactDuplicateReason[] = [];
    if (row.same_email) reasons.push("email");
    if (row.same_phone) reasons.push("phone");
    if (row.same_name) reasons.push("name");
    return [{ first, second, reasons }];
  });
};

const uniqueBy = <T>(items: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
};

/** Merges a duplicate into the chosen record while preserving related data. */
export const mergeDuplicate = async (config: {
  bookId: string;
  keepId: string;
  removeId: string;
  keepUpdatedAt: string;
  removeUpdatedAt: string;
}): Promise<Result<Contact>> => {
  if (!isUuid(config.bookId) || !isUuid(config.keepId) || !isUuid(config.removeId)) return fail(err.notFound("Contact"));
  if (config.keepId === config.removeId) return fail(err.badInput("Choose two different contacts"));
  const current = await getMany({ bookId: config.bookId, ids: [config.keepId, config.removeId] });
  if (!current.ok) return current;
  const [keep, duplicate] = current.data;
  if (!keep || !duplicate) return fail(err.notFound("Contact"));

  const emails = uniqueBy([...keep.emails, ...duplicate.emails], (item) => item.email.trim().toLowerCase()).map(({ label, email }) => ({
    label,
    email,
  }));
  const phones = uniqueBy([...keep.phones, ...duplicate.phones], (item) => item.phone.replace(/[^0-9+]/g, "")).map(({ label, phone }) => ({
    label,
    phone,
  }));
  const websites = uniqueBy([...keep.websites, ...duplicate.websites], (item) => item.url.trim().toLowerCase()).map(({ label, url }) => ({
    label,
    url,
  }));
  const addresses = uniqueBy([...keep.addresses, ...duplicate.addresses], (item) =>
    [item.line1, item.line2, item.postalCode, item.city, item.countryCode].map((value) => value?.trim().toLowerCase() ?? "").join("|"),
  ).map(({ label, recipientName, companyName, line1, line2, postalCode, city, stateRegion, countryCode }) => ({
    label,
    recipientName,
    companyName,
    line1,
    line2,
    postalCode,
    city,
    stateRegion,
    countryCode,
  }));
  const bankAccounts = uniqueBy([...keep.bankAccounts, ...duplicate.bankAccounts], (item) =>
    item.iban.replaceAll(" ", "").toUpperCase(),
  ).map(({ label, accountHolderName, iban, bic, bankName, note }) => ({ label, accountHolderName, iban, bic, bankName, note }));
  const merged = await sql.begin(async (tx) => {
    const locked = await tx<{ id: string; parent_contact_id: string | null; updated_at: Date }[]>`
      SELECT id, parent_contact_id, updated_at FROM contacts.contacts
      WHERE book_id = ${config.bookId}::uuid
        AND id = ANY(${toPgUuidArray([keep.id, duplicate.id])}::uuid[])
      FOR UPDATE
    `;
    if (locked.length !== 2) return false;
    const lockedKeep = locked.find((contact) => contact.id === keep.id);
    const lockedDuplicate = locked.find((contact) => contact.id === duplicate.id);
    if (
      !lockedKeep ||
      !lockedDuplicate ||
      lockedKeep.updated_at.toISOString() !== config.keepUpdatedAt ||
      lockedDuplicate.updated_at.toISOString() !== config.removeUpdatedAt
    ) {
      return false;
    }
    const nextParentId =
      lockedKeep.parent_contact_id === duplicate.id
        ? lockedDuplicate.parent_contact_id === keep.id
          ? null
          : lockedDuplicate.parent_contact_id
        : (lockedKeep.parent_contact_id ?? (lockedDuplicate.parent_contact_id === keep.id ? null : lockedDuplicate.parent_contact_id));
    const [descendantCheck] = await tx<{ exists: boolean }[]>`
      WITH RECURSIVE descendants AS (
        SELECT id FROM contacts.contacts WHERE parent_contact_id = ${duplicate.id}::uuid
        UNION ALL
        SELECT child.id
        FROM contacts.contacts child
        JOIN descendants parent ON child.parent_contact_id = parent.id
      )
      SELECT EXISTS (SELECT 1 FROM descendants WHERE id = ${keep.id}::uuid) AS "exists"
    `;
    const childParentId = descendantCheck?.exists ? lockedDuplicate.parent_contact_id : keep.id;
    await tx`
      UPDATE contacts.contacts target
      SET
        label = COALESCE(NULLIF(target.label, ''), NULLIF(source.label, '')),
        first_name = COALESCE(NULLIF(target.first_name, ''), NULLIF(source.first_name, '')),
        last_name = COALESCE(NULLIF(target.last_name, ''), NULLIF(source.last_name, '')),
        company_name = COALESCE(NULLIF(target.company_name, ''), NULLIF(source.company_name, '')),
        department = COALESCE(NULLIF(target.department, ''), NULLIF(source.department, '')),
        job_title = COALESCE(NULLIF(target.job_title, ''), NULLIF(source.job_title, '')),
        vat_id = COALESCE(NULLIF(target.vat_id, ''), NULLIF(source.vat_id, '')),
        birthday = COALESCE(target.birthday, source.birthday),
        salutation = COALESCE(NULLIF(target.salutation, ''), NULLIF(source.salutation, '')),
        pronouns = COALESCE(NULLIF(target.pronouns, ''), NULLIF(source.pronouns, '')),
        preferred_language = COALESCE(NULLIF(target.preferred_language, ''), NULLIF(source.preferred_language, '')),
        source = COALESCE(NULLIF(target.source, ''), NULLIF(source.source, '')),
        parent_contact_id = ${nextParentId},
        updated_at = now()
      FROM contacts.contacts source
      WHERE target.id = ${keep.id}::uuid AND source.id = ${duplicate.id}::uuid
    `;
    await replaceContactCollections(keep.id, { emails, phones, websites, addresses, bankAccounts }, tx);
    await tx`
      INSERT INTO contacts.contact_tag_assignments (contact_id, tag_id)
      SELECT ${keep.id}::uuid, tag_id
      FROM contacts.contact_tag_assignments
      WHERE contact_id = ${duplicate.id}::uuid
      ON CONFLICT DO NOTHING
    `;
    await tx`UPDATE contacts.contact_notes SET contact_id = ${keep.id}::uuid WHERE contact_id = ${duplicate.id}::uuid`;
    await tx`
      UPDATE contacts.contacts
      SET parent_contact_id = ${childParentId}, updated_at = now()
      WHERE parent_contact_id = ${duplicate.id}::uuid AND id <> ${keep.id}::uuid
    `;
    await tx`
      INSERT INTO contacts.contact_favorites (user_id, book_id, contact_id, created_at)
      SELECT user_id, book_id, ${keep.id}::uuid, created_at
      FROM contacts.contact_favorites
      WHERE book_id = ${config.bookId} AND contact_id = ${duplicate.id}::uuid
      ON CONFLICT DO NOTHING
    `;
    await tx`
      DELETE FROM contacts.contact_favorites
      WHERE book_id = ${config.bookId} AND contact_id = ${duplicate.id}::uuid
    `;
    await tx`DELETE FROM contacts.contacts WHERE id = ${duplicate.id}::uuid AND book_id = ${config.bookId}::uuid`;
    return true;
  });
  if (!merged) return fail(err.conflict("Contacts changed while merging; review them again"));
  const contact = await get({ bookId: config.bookId, id: keep.id });
  return contact ? ok(contact) : fail(err.internal("Failed to load merged contact"));
};

/** Global search across all readable persisted contact books. */
export const search = async (config: {
  subject: AccessSubject;
  boundBookId?: string | null;
  bypassAccess?: boolean;
  pagination?: PageParams;
  filter?: ContactListFilter;
}): Promise<Paginated<Contact>> => {
  const { page, perPage, offset } = paginate(config.pagination);
  if (config.subject.type === "service_account" && !isUuid(config.boundBookId ?? "")) {
    return { items: [], page, perPage, total: 0, hasNext: false };
  }
  const requestedFavoriteUserId = config.filter?.favoriteUserId;
  if (requestedFavoriteUserId !== undefined && !isUuid(requestedFavoriteUserId)) {
    return { items: [], page, perPage, total: 0, hasNext: false };
  }
  const requestedTagIds = [...new Set(config.filter?.tagIds ?? [])];
  if (requestedTagIds.some((tagId) => !isUuid(tagId))) {
    return { items: [], page, perPage, total: 0, hasNext: false };
  }

  const searchPattern = buildSearchPattern(config.filter?.query);
  const tagIdsArray = requestedTagIds.length > 0 ? toPgUuidArray(requestedTagIds) : null;
  const emailPresence = config.filter?.email ?? "all";
  const phonePresence = config.filter?.phone ?? "all";
  const sort = config.filter?.sort ?? "name";
  const favoriteUserId = requestedFavoriteUserId ?? null;
  const bindingMatch = config.subject.type === "service_account" ? sql`c.book_id = ${config.boundBookId}::uuid` : sql`true`;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(DISTINCT c.id)::int AS count
    FROM contacts.contacts c
    LEFT JOIN contacts.book_access ba ON ba.book_id = c.book_id
    LEFT JOIN auth.access a ON a.id = ba.access_id
    LEFT JOIN contacts.contact_emails ce ON ce.contact_id = c.id
    LEFT JOIN contacts.contact_phones cp ON cp.contact_id = c.id
    LEFT JOIN contacts.contact_addresses ca ON ca.contact_id = c.id
    LEFT JOIN contacts.contact_bank_accounts cba ON cba.contact_id = c.id
    WHERE (${config.bypassAccess ?? false}::boolean OR ${mapManualReadableAccessCondition(config.subject)})
      AND ${bindingMatch}
      AND ${mapManualSearchCondition(searchPattern)}
      AND (${tagIdsArray}::uuid[] IS NULL OR EXISTS (
        SELECT 1 FROM contacts.contact_tag_assignments cta
        WHERE cta.contact_id = c.id AND cta.tag_id = ANY(${tagIdsArray}::uuid[])
      ))
      AND (${favoriteUserId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM contacts.contact_favorites favorite
        WHERE favorite.user_id = ${favoriteUserId}::uuid
          AND favorite.book_id = c.book_id::text
          AND favorite.contact_id = c.id
      ))
      AND (${emailPresence} = 'all' OR (${emailPresence} = 'yes' AND ce.id IS NOT NULL) OR (${emailPresence} = 'no' AND NOT EXISTS (
        SELECT 1 FROM contacts.contact_emails email_filter WHERE email_filter.contact_id = c.id
      )))
      AND (${phonePresence} = 'all' OR (${phonePresence} = 'yes' AND cp.id IS NOT NULL) OR (${phonePresence} = 'no' AND NOT EXISTS (
        SELECT 1 FROM contacts.contact_phones phone_filter WHERE phone_filter.contact_id = c.id
      )))
  `;

  const rows = await sql<SearchRow[]>`
    WITH matches AS (
      SELECT DISTINCT
        c.id AS contact_id,
        c.book_id::text AS book_id,
        COALESCE(
          NULLIF(c.label, ''),
          NULLIF(TRIM(CONCAT_WS(' ', COALESCE(c.first_name, ''), COALESCE(c.last_name, ''))), ''),
          NULLIF(c.company_name, '')
        ) AS sort_name,
        LOWER(NULLIF(TRIM(c.company_name), '')) AS sort_company,
        c.created_at AS created_at,
        c.updated_at AS updated_at
      FROM contacts.contacts c
      LEFT JOIN contacts.book_access ba ON ba.book_id = c.book_id
      LEFT JOIN auth.access a ON a.id = ba.access_id
      LEFT JOIN contacts.contact_emails ce ON ce.contact_id = c.id
      LEFT JOIN contacts.contact_phones cp ON cp.contact_id = c.id
      LEFT JOIN contacts.contact_addresses ca ON ca.contact_id = c.id
      LEFT JOIN contacts.contact_bank_accounts cba ON cba.contact_id = c.id
      WHERE (${config.bypassAccess ?? false}::boolean OR ${mapManualReadableAccessCondition(config.subject)})
        AND ${bindingMatch}
        AND ${mapManualSearchCondition(searchPattern)}
        AND (${tagIdsArray}::uuid[] IS NULL OR EXISTS (
          SELECT 1 FROM contacts.contact_tag_assignments cta
          WHERE cta.contact_id = c.id AND cta.tag_id = ANY(${tagIdsArray}::uuid[])
        ))
        AND (${favoriteUserId}::uuid IS NULL OR EXISTS (
          SELECT 1 FROM contacts.contact_favorites favorite
          WHERE favorite.user_id = ${favoriteUserId}::uuid
            AND favorite.book_id = c.book_id::text
            AND favorite.contact_id = c.id
        ))
        AND (${emailPresence} = 'all' OR (${emailPresence} = 'yes' AND ce.id IS NOT NULL) OR (${emailPresence} = 'no' AND NOT EXISTS (
          SELECT 1 FROM contacts.contact_emails email_filter WHERE email_filter.contact_id = c.id
        )))
        AND (${phonePresence} = 'all' OR (${phonePresence} = 'yes' AND cp.id IS NOT NULL) OR (${phonePresence} = 'no' AND NOT EXISTS (
          SELECT 1 FROM contacts.contact_phones phone_filter WHERE phone_filter.contact_id = c.id
        )))
    )
    SELECT contact_id, book_id
    FROM matches
    ORDER BY
      CASE WHEN ${sort} = 'updated' THEN updated_at END DESC,
      CASE WHEN ${sort} = 'created' THEN created_at END DESC,
      CASE WHEN ${sort} = 'company' THEN sort_company END ASC NULLS LAST,
      LOWER(sort_name) ASC,
      contact_id ASC
    LIMIT ${perPage}
    OFFSET ${offset}
  `;

  const byId = await getManualContactsByIds(rows.map((row) => row.contact_id));
  const items = rows.map((row) => byId.get(row.contact_id) ?? null).filter((item): item is Contact => item !== null);

  const total = countRow?.count ?? 0;
  return {
    items,
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};
