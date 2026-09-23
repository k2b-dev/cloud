import { z } from "zod";
import { CapabilitySemanticLinkSchema, CloudResourceRefSchema } from "./capabilities";

/**
 * Provider-neutral contact-directory contract.
 *
 * A consumer such as Mail maps each function to one Query or Action of one
 * provider application. Providers keep their own identifiers, permissions,
 * and extra result fields; the schemas below are the minimum both sides share.
 */

const ContactDirectoryIdSchema = z.string().min(1).max(512);
const TimestampSchema = z.string().datetime({ offset: true });
const NullableTextSchema = z.string().nullable();
const CursorSchema = z.string().min(1).max(256);
const EmailSchema = z.email().max(320);
const LinksSchema = z.array(CapabilitySemanticLinkSchema).min(1).max(10).optional();

const ContactDirectoryEmailSchema = z.object({ label: NullableTextSchema, email: z.email() }).loose();
const ContactDirectoryPhoneSchema = z.object({ label: NullableTextSchema, phone: z.string().min(1) }).loose();

const contactFacts = {
  contactId: ContactDirectoryIdSchema,
  bookId: ContactDirectoryIdSchema,
  displayName: z.string().min(1),
  companyName: NullableTextSchema,
  jobTitle: NullableTextSchema,
  contactPointsTruncated: z.boolean(),
  links: LinksSchema,
  updatedAt: TimestampSchema,
};

export const ContactDirectorySuggestInputSchema = z
  .object({
    query: z.string().min(2).max(500).describe("Text typed by the user, matched against names, organizations, and email addresses."),
    cursor: CursorSchema.optional().describe("Opaque cursor returned by the previous page."),
    limit: z.number().int().min(1).max(25).optional().describe("Maximum number of suggestions to return."),
  })
  .strict();

export const ContactDirectorySuggestionSchema = z
  .object({
    ...contactFacts,
    emails: z.array(ContactDirectoryEmailSchema).min(1).max(20),
    phones: z.array(ContactDirectoryPhoneSchema).max(20),
  })
  .loose();
export const ContactDirectorySuggestDataSchema = z.array(ContactDirectorySuggestionSchema).max(25);

export const ContactDirectoryResolveInputSchema = z
  .object({
    emails: z.array(EmailSchema).min(1).max(100).describe("Normalized email addresses to resolve to every readable matching contact."),
    contactIds: z
      .array(ContactDirectoryIdSchema)
      .max(20)
      .optional()
      .describe("Optional contact IDs returned by this provider that further restrict the matches."),
    cursor: CursorSchema.optional().describe("Opaque cursor returned by the previous page."),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum number of exact contact matches to return."),
  })
  .strict();

export const ContactDirectoryMatchSchema = z
  .object({
    ref: CloudResourceRefSchema,
    ...contactFacts,
    bookName: z.string().min(1),
    matchedEmails: z.array(EmailSchema).min(1).max(100),
    emails: z.array(ContactDirectoryEmailSchema).max(20),
    phones: z.array(ContactDirectoryPhoneSchema).max(20),
  })
  .loose();
export const ContactDirectoryResolveDataSchema = z
  .object({
    items: z.array(ContactDirectoryMatchSchema).max(50),
    matchedEmails: z.array(EmailSchema).max(100),
  })
  .loose();

export const ContactDirectoryReadInputSchema = z
  .object({ id: ContactDirectoryIdSchema.describe("Contact ID returned by this provider.") })
  .strict();

export const ContactDirectoryContactSchema = z
  .object({
    id: ContactDirectoryIdSchema,
    bookId: ContactDirectoryIdSchema,
    displayName: z.string().min(1),
    companyName: NullableTextSchema,
    jobTitle: NullableTextSchema,
    emails: z.array(ContactDirectoryEmailSchema).max(100),
    phones: z.array(ContactDirectoryPhoneSchema).max(100),
    updatedAt: TimestampSchema,
  })
  .loose();

export const ContactDirectoryBookListInputSchema = z
  .object({
    query: z.string().max(500).optional().describe("Optional book name or description search."),
    minimumPermission: z.literal("write").describe("Only books in which the caller can create contacts."),
    cursor: CursorSchema.optional().describe("Opaque cursor returned by the previous page."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum number of books to return."),
  })
  .strict();

export const ContactDirectoryBookSchema = z
  .object({ id: ContactDirectoryIdSchema, name: z.string().min(1), description: NullableTextSchema })
  .loose();
export const ContactDirectoryBookListDataSchema = z.array(ContactDirectoryBookSchema).max(100);

const ContactPointLabelSchema = z.string().max(100).nullable().optional().describe("Optional label.");
const ContactNameFieldSchema = z.string().max(200).nullable().optional();

export const ContactDirectoryCreateInputSchema = z
  .object({
    bookId: ContactDirectoryIdSchema.describe("Writable book ID returned by the book list."),
    label: ContactNameFieldSchema.describe("Optional display label."),
    firstName: ContactNameFieldSchema.describe("Person first name."),
    lastName: ContactNameFieldSchema.describe("Person last name."),
    companyName: ContactNameFieldSchema.describe("Organization name."),
    emails: z
      .array(z.object({ label: ContactPointLabelSchema, email: EmailSchema.describe("Email address.") }).strict())
      .max(20)
      .optional()
      .describe("Email addresses."),
    phones: z
      .array(z.object({ label: ContactPointLabelSchema, phone: z.string().min(1).max(100).describe("Phone number.") }).strict())
      .max(20)
      .optional()
      .describe("Phone numbers."),
  })
  .strict();
export const ContactDirectoryCreateDataSchema = z.object({ contact: ContactDirectoryContactSchema }).loose();

/**
 * The five contact-directory functions. `kind` and `idempotency` are part of
 * the contract: a provider capability must match them to be selectable.
 */
export const contactDirectory = {
  suggest: { kind: "query", input: ContactDirectorySuggestInputSchema, data: ContactDirectorySuggestDataSchema },
  resolve: { kind: "query", input: ContactDirectoryResolveInputSchema, data: ContactDirectoryResolveDataSchema },
  read: { kind: "query", input: ContactDirectoryReadInputSchema, data: ContactDirectoryContactSchema },
  listWritableBooks: { kind: "query", input: ContactDirectoryBookListInputSchema, data: ContactDirectoryBookListDataSchema },
  create: {
    kind: "action",
    idempotency: "required",
    input: ContactDirectoryCreateInputSchema,
    data: ContactDirectoryCreateDataSchema,
  },
} as const;

export type ContactDirectoryFunction = keyof typeof contactDirectory;
export const CONTACT_DIRECTORY_FUNCTIONS = Object.keys(contactDirectory) as ContactDirectoryFunction[];

export type ContactDirectorySuggestion = z.output<typeof ContactDirectorySuggestionSchema>;
export type ContactDirectoryMatch = z.output<typeof ContactDirectoryMatchSchema>;
export type ContactDirectoryContact = z.output<typeof ContactDirectoryContactSchema>;
export type ContactDirectoryBook = z.output<typeof ContactDirectoryBookSchema>;
