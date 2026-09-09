import { CapabilitySemanticLinkSchema } from "@k2b/cloud/contracts";
import { z } from "zod";

const NullableTextSchema = z.string().nullable();
const TimestampSchema = z.string().datetime({ offset: true });
const CursorSchema = z.string().min(1).max(256).optional().describe("Opaque cursor returned by the previous page.");
const LimitSchema = z.number().int().min(1).max(100).default(25).describe("Maximum number of results to return.");
const ResourceLinksSchema = z.array(CapabilitySemanticLinkSchema).min(1).max(10).optional();
const ContactOpenHrefSchema = z.string().regex(/^\/app\/contacts\/.*/);
export const ResourceShortIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);
const resourceRef = <Type extends string>(type: Type) =>
  z.object({ type: z.literal(type), id: ResourceShortIdSchema }).strict();
export const CONTACT_COLLECTION_LIMIT = 20;
export const CONTACT_TAG_LIMIT = 100;

const CapabilityPageInputShape = {
  cursor: CursorSchema,
  limit: LimitSchema,
};

export const NormalizedContactEmailSchema = z.email().max(320);

export const ContactTagDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    bookId: ResourceShortIdSchema,
    name: z.string().min(1),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    links: ResourceLinksSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

const ContactEmailDataSchema = z.object({ label: NullableTextSchema, email: z.email() }).strict();
const ContactPhoneDataSchema = z.object({ label: NullableTextSchema, phone: z.string().min(1) }).strict();
const ContactWebsiteDataSchema = z.object({ label: NullableTextSchema, url: z.string().url() }).strict();
const ContactAddressDataSchema = z
  .object({
    label: NullableTextSchema,
    recipientName: NullableTextSchema,
    companyName: NullableTextSchema,
    line1: z.string().min(1),
    line2: NullableTextSchema,
    postalCode: z.string(),
    city: z.string(),
    stateRegion: NullableTextSchema,
    countryCode: z.string().length(2),
  })
  .strict();
const ContactBankAccountDataSchema = z
  .object({
    label: NullableTextSchema,
    accountHolderName: z.string().min(1),
    iban: z.string().min(1),
    bic: NullableTextSchema,
    bankName: NullableTextSchema,
    note: NullableTextSchema,
  })
  .strict();

const ContactSummaryDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    bookId: ResourceShortIdSchema,
    displayName: z.string().min(1),
    companyName: NullableTextSchema,
    jobTitle: NullableTextSchema,
    primaryEmail: z.email().nullable(),
    primaryPhone: NullableTextSchema,
    tags: z.array(ContactTagDataSchema).max(CONTACT_TAG_LIMIT),
    updatedAt: TimestampSchema,
  })
  .strict();

const ContactLookupEmailDataSchema = z.object({ label: NullableTextSchema, email: z.email() }).strict();
const ContactLookupPhoneDataSchema = z.object({ label: NullableTextSchema, phone: z.string().min(1) }).strict();

export const ContactSuggestInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(500)
      .describe("Text matched against readable contact names, organizations, email addresses, phone numbers, and addresses."),
    cursor: CursorSchema,
    limit: z.number().int().min(1).max(25).default(8).describe("Maximum number of contact suggestions to return."),
  })
  .strict();

export const ContactSuggestionDataSchema = z
  .object({
    ref: resourceRef("contacts.contact"),
    contactId: ResourceShortIdSchema,
    bookId: ResourceShortIdSchema,
    displayName: z.string().min(1),
    companyName: NullableTextSchema,
    jobTitle: NullableTextSchema,
    emails: z.array(ContactLookupEmailDataSchema).min(1).max(20),
    phones: z.array(ContactLookupPhoneDataSchema).max(20),
    contactPointsTruncated: z.boolean(),
    openHref: ContactOpenHrefSchema,
    links: ResourceLinksSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ContactSuggestDataSchema = z.array(ContactSuggestionDataSchema).max(25);

export const ContactResolveInputSchema = z
  .object({
    emails: z
      .array(NormalizedContactEmailSchema)
      .min(1)
      .max(100)
      .describe("Normalized email addresses to resolve to every readable matching contact."),
    contactIds: z
      .array(ResourceShortIdSchema)
      .max(20)
      .optional()
      .describe("Optional public contact IDs that further restrict the matches."),
    cursor: CursorSchema,
    limit: z.number().int().min(1).max(50).default(25).describe("Maximum number of exact contact matches to return."),
  })
  .strict();

export const ContactResolveMatchDataSchema = z
  .object({
    ref: resourceRef("contacts.contact"),
    contactId: ResourceShortIdSchema,
    bookId: ResourceShortIdSchema,
    bookName: z.string().min(1),
    displayName: z.string().min(1),
    companyName: NullableTextSchema,
    jobTitle: NullableTextSchema,
    matchedEmails: z.array(NormalizedContactEmailSchema).min(1).max(100),
    emails: z.array(ContactLookupEmailDataSchema).max(20),
    phones: z.array(ContactLookupPhoneDataSchema).max(20),
    contactPointsTruncated: z.boolean(),
    openHref: ContactOpenHrefSchema,
    links: ResourceLinksSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ContactResolveDataSchema = z
  .object({
    items: z.array(ContactResolveMatchDataSchema).max(50),
    matchedEmails: z.array(NormalizedContactEmailSchema).max(100),
  })
  .strict();

export const ContactDetailDataSchema = ContactSummaryDataSchema.extend({
  label: NullableTextSchema,
  firstName: NullableTextSchema,
  lastName: NullableTextSchema,
  department: NullableTextSchema,
  vatId: NullableTextSchema,
  birthday: NullableTextSchema,
  salutation: NullableTextSchema,
  pronouns: NullableTextSchema,
  preferredLanguage: NullableTextSchema,
  parentContactId: ResourceShortIdSchema.nullable(),
  emails: z.array(ContactEmailDataSchema).max(CONTACT_COLLECTION_LIMIT),
  phones: z.array(ContactPhoneDataSchema).max(CONTACT_COLLECTION_LIMIT),
  addresses: z.array(ContactAddressDataSchema).max(CONTACT_COLLECTION_LIMIT),
  websites: z.array(ContactWebsiteDataSchema).max(CONTACT_COLLECTION_LIMIT),
  bankAccounts: z.array(ContactBankAccountDataSchema).max(CONTACT_COLLECTION_LIMIT),
  truncatedFields: z.array(z.enum(["tags", "emails", "phones", "addresses", "websites", "bankAccounts"])).max(6),
  createdAt: TimestampSchema,
}).strict();

export const ContactListInputSchema = z
  .object({
    bookId: ResourceShortIdSchema.describe("Address-book ID returned by List address books or a contacts.book resource ref."),
    query: z.string().trim().max(500).optional().describe("Optional text matched against contact fields."),
    tagIds: z
      .array(ResourceShortIdSchema)
      .max(100)
      .optional()
      .describe("Contact-tag IDs returned by List contact tags for this address book; matches contacts having at least one."),
    sort: z.enum(["name", "updated", "created", "company"]).default("name").describe("Contact sort order."),
    email: z.enum(["all", "yes", "no"]).default("all").describe("Filter by email-address presence."),
    phone: z.enum(["all", "yes", "no"]).default("all").describe("Filter by phone-number presence."),
    favoritesOnly: z.boolean().default(false).describe("Only contacts favorited by the current user."),
    ...CapabilityPageInputShape,
  })
  .strict();

export const ContactReadInputSchema = z
  .object({ id: ResourceShortIdSchema.describe("Contact ID returned by contact search, suggest, resolve, list, or a contacts.contact ref.") })
  .strict();

export const ContactBookReadInputSchema = z
  .object({ id: ResourceShortIdSchema.describe("Address-book ID returned by List address books or a contacts.book ref.") })
  .strict();
export const ContactBookDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    name: z.string().min(1),
    description: NullableTextSchema,
    permission: z.enum(["read", "write", "admin"]),
    links: ResourceLinksSchema,
    createdAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema.nullable(),
  })
  .strict();
const ContactBookListItemDataSchema = ContactBookDataSchema.extend({ ref: resourceRef("contacts.book") }).strict();
export const ContactBookListDataSchema = z.array(ContactBookListItemDataSchema).max(100);
export const ContactBookListInputSchema = z
  .object({
    query: z.string().trim().max(500).optional().describe("Optional address-book name or description search."),
    minimumPermission: z
      .enum(["read", "write", "admin"])
      .default("read")
      .describe("Minimum effective permission required for each returned address book."),
    ...CapabilityPageInputShape,
  })
  .strict();

export const ContactTagReadInputSchema = z
  .object({ id: ResourceShortIdSchema.describe("Contact-tag ID returned by List contact tags or a contacts.tag ref.") })
  .strict();
const ContactTagListItemDataSchema = ContactTagDataSchema.extend({ ref: resourceRef("contacts.tag") }).strict();
export const ContactTagListDataSchema = z.array(ContactTagListItemDataSchema).max(100);
export const ContactTagListInputSchema = z
  .object({
    bookId: ResourceShortIdSchema.describe("Address-book ID returned by List address books or a contacts.book ref."),
    ...CapabilityPageInputShape,
  })
  .strict();

export const ContactNoteReadInputSchema = z
  .object({ id: ResourceShortIdSchema.describe("Contact-note ID returned by List contact notes or a contacts.note ref.") })
  .strict();
export const ContactNoteDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    contactId: ResourceShortIdSchema,
    authorUserId: z.uuid().nullable(),
    authorDisplayName: z.string().min(1),
    content: z.string().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
const ContactNoteListItemDataSchema = ContactNoteDataSchema.extend({ ref: resourceRef("contacts.note") }).strict();
export const ContactNoteListDataSchema = z.array(ContactNoteListItemDataSchema).max(100);
export const ContactNoteListInputSchema = z
  .object({
    contactId: ResourceShortIdSchema.describe("Contact ID returned by contact search, suggest, resolve, list, or a contacts.contact ref."),
    ...CapabilityPageInputShape,
  })
  .strict();

const EmailInputSchema = z
  .object({
    label: z.string().trim().max(100).nullable().optional().describe("Optional email label."),
    email: z.email().max(320).describe("Email address."),
  })
  .strict();
const PhoneInputSchema = z
  .object({
    label: z.string().trim().max(100).nullable().optional().describe("Optional phone label."),
    phone: z.string().trim().min(1).max(100).describe("Phone number."),
  })
  .strict();
const WebsiteInputSchema = z
  .object({
    label: z.string().trim().max(100).nullable().optional().describe("Optional website label."),
    url: z.string().url().max(2048).describe("Website URL."),
  })
  .strict();
const AddressInputSchema = z
  .object({
    label: z.string().trim().max(100).nullable().optional().describe("Optional address label."),
    recipientName: z.string().trim().max(200).nullable().optional().describe("Optional recipient name."),
    companyName: z.string().trim().max(200).nullable().optional().describe("Optional company name."),
    line1: z.string().trim().min(1).max(300).describe("Primary street address line."),
    line2: z.string().trim().max(300).nullable().optional().describe("Optional secondary address line."),
    postalCode: z.string().trim().max(50).describe("Postal code."),
    city: z.string().trim().max(200).describe("City or locality."),
    stateRegion: z.string().trim().max(200).nullable().optional().describe("Optional state or region."),
    countryCode: z.string().trim().length(2).describe("Two-letter country code."),
  })
  .strict();
const BankAccountInputSchema = z
  .object({
    label: z.string().trim().max(100).nullable().optional().describe("Optional bank-account label."),
    accountHolderName: z.string().trim().min(1).max(200).describe("Account holder name."),
    iban: z.string().trim().min(1).max(80).describe("IBAN or local account identifier."),
    bic: z.string().trim().max(40).nullable().optional().describe("Optional BIC."),
    bankName: z.string().trim().max(200).nullable().optional().describe("Optional bank name."),
    note: z.string().trim().max(1000).nullable().optional().describe("Optional account note."),
  })
  .strict();

const ContactFieldsShape = {
  label: z.string().trim().max(200).nullable().optional().describe("Optional explicit display label."),
  firstName: z.string().trim().max(200).nullable().optional().describe("Person first name."),
  lastName: z.string().trim().max(200).nullable().optional().describe("Person last name."),
  companyName: z.string().trim().max(200).nullable().optional().describe("Organization name."),
  department: z.string().trim().max(200).nullable().optional().describe("Organization department."),
  jobTitle: z.string().trim().max(200).nullable().optional().describe("Job title."),
  vatId: z.string().trim().max(100).nullable().optional().describe("VAT identifier."),
  birthday: z.string().date().nullable().optional().describe("Birthday as YYYY-MM-DD."),
  salutation: z.string().trim().max(100).nullable().optional().describe("Preferred salutation."),
  pronouns: z.string().trim().max(100).nullable().optional().describe("Preferred pronouns."),
  preferredLanguage: z.string().trim().max(40).nullable().optional().describe("Preferred language code."),
  parentContactId: ResourceShortIdSchema.nullable().optional().describe("Optional public parent contact ID in the same book."),
  tagIds: z
    .array(ResourceShortIdSchema)
    .max(CONTACT_TAG_LIMIT)
    .optional()
    .describe("Complete replacement set of public book-scoped tag IDs."),
  emails: z.array(EmailInputSchema).max(CONTACT_COLLECTION_LIMIT).optional().describe("Complete replacement set of email addresses."),
  phones: z.array(PhoneInputSchema).max(CONTACT_COLLECTION_LIMIT).optional().describe("Complete replacement set of phone numbers."),
  addresses: z.array(AddressInputSchema).max(CONTACT_COLLECTION_LIMIT).optional().describe("Complete replacement set of postal addresses."),
  websites: z.array(WebsiteInputSchema).max(CONTACT_COLLECTION_LIMIT).optional().describe("Complete replacement set of websites."),
  bankAccounts: z
    .array(BankAccountInputSchema)
    .max(CONTACT_COLLECTION_LIMIT)
    .optional()
    .describe("Complete replacement set of bank accounts."),
};

export const ContactCreateInputSchema = z
  .object({
    bookId: ResourceShortIdSchema.describe("Public address-book ID that will own the contact."),
    ...ContactFieldsShape,
  })
  .strict()
  .refine(
    (value) => Boolean(value.label || value.firstName || value.lastName || value.companyName),
    "Provide a label, person name, or company name.",
  );

export const ContactUpdateInputSchema = z
  .object({
    contactId: ResourceShortIdSchema.describe("Stable public contact ID to update."),
    expectedUpdatedAt: TimestampSchema.describe("updatedAt value returned by the last read; prevents lost updates."),
    ...ContactFieldsShape,
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "contactId" && key !== "expectedUpdatedAt"),
    "Provide at least one contact field to update.",
  );

export const ContactMoveInputSchema = z
  .object({
    contactId: ResourceShortIdSchema.describe("Stable public contact ID to move."),
    targetBookId: ResourceShortIdSchema.describe("Public writable destination address-book ID."),
    expectedUpdatedAt: TimestampSchema.describe("updatedAt value returned by the last read; prevents stale moves."),
  })
  .strict();

export const ContactDeleteInputSchema = z
  .object({
    contactId: ResourceShortIdSchema.describe("Stable public contact ID to delete."),
    expectedUpdatedAt: TimestampSchema.describe("updatedAt value returned by the last read; prevents stale deletion."),
  })
  .strict();

export const FavoriteSetInputSchema = z
  .object({
    contactId: ResourceShortIdSchema.describe("Stable public contact ID."),
    favorite: z.boolean().describe("Desired favorite state for the current user."),
  })
  .strict();

export const ContactTagChangeInputSchema = z
  .object({
    contactId: ResourceShortIdSchema.describe("Stable public contact ID whose tags should change."),
    addTagIds: z.array(ResourceShortIdSchema).max(100).default([]).describe("Public book-scoped tag IDs to add."),
    removeTagIds: z.array(ResourceShortIdSchema).max(100).default([]).describe("Public book-scoped tag IDs to remove."),
  })
  .strict()
  .refine((value) => value.addTagIds.length > 0 || value.removeTagIds.length > 0, "Choose at least one tag to add or remove.");

export const ContactNoteCreateInputSchema = z
  .object({
    contactId: ResourceShortIdSchema.describe("Stable public contact ID that will own the note."),
    content: z.string().trim().min(1).max(10_000).describe("Plain-text note content."),
  })
  .strict();

export const ContactMutationDataSchema = z.object({ contact: ContactDetailDataSchema }).strict();
export const ContactDeleteDataSchema = z.object({ contactId: ResourceShortIdSchema, deleted: z.literal(true) }).strict();
export const FavoriteSetDataSchema = z.object({ contactId: ResourceShortIdSchema, favorite: z.boolean() }).strict();
export const ContactTagChangeDataSchema = z
  .object({ contactId: ResourceShortIdSchema, tags: z.array(ContactTagDataSchema).max(CONTACT_TAG_LIMIT), tagsTruncated: z.boolean() })
  .strict();
export const ContactNoteCreateDataSchema = z.object({ note: ContactNoteDataSchema }).strict();
