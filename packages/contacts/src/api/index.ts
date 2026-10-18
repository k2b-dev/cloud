import { cliAmbiguityText, localizeCloudCliText } from "@k2b/cloud/cli";
import {
  AccessEntrySchema,
  createPagination,
  ErrorResponseSchema,
  GrantAccessSchema,
  MessageResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  type PermissionLevel,
  parsePagination,
  ServiceAccountCredentialSchema,
  UpdateAccessSchema,
} from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, rateLimit, requiresAuth, respond, respondMessage, v } from "@k2b/cloud/server";
import { err, fail, ok, type ServiceError } from "@k2b/stdlib";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ResourceShortIdSchema } from "../capability-contracts";
import { contactsService } from "../service";
import { readableBookScope } from "../service/access";
import { contactsLive } from "../service/live";
import { contactsLiveChannels } from "../service/live-channels";
import { contactsApiErrorMessage, contactsMessages, notFoundError } from "../service/messages";
import {
  projectBooks,
  projectContactReferences,
  projectContacts,
  projectDuplicates,
  projectFavorites,
  projectNotes,
  projectTags,
  projectTrees,
  resolveBookPublicIds,
  resolvePublicId,
  resolvePublicIds,
} from "../service/public-resources";
import { isUuid } from "../service/shared";
import type { Contact, ContactBook } from "../service/types";
import * as vcard from "../service/vcard";
import { isSafeWebsiteUrl, resolveContactName } from "../shared";
import legacyLiveRoutes from "../ws";
import { exportBody } from "./export-stream";

const documentRoute = (options: Parameters<typeof describeRoute>[0]) => describeRoute(options) as MiddlewareHandler<AuthContext>;

// Every authenticated route can return 401; book-scoped services add 403/404.
const authResponses = { 401: jsonResponse(ErrorResponseSchema, "Authentication required") };
const bookScopedResponses = {
  ...authResponses,
  403: jsonResponse(ErrorResponseSchema, "Access denied"),
  404: jsonResponse(ErrorResponseSchema, "Book not found"),
};

const MAX_IMPORT_CONTACTS = contactsService.import.MAX_IMPORT_CONTACTS;
const MAX_IMPORT_CONTENT_CHARS = contactsService.import.MAX_IMPORT_CONTENT_CHARS;
const MAX_IMPORT_BODY_BYTES = contactsService.import.MAX_IMPORT_BODY_BYTES;
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be a #RRGGBB hex value");

const localizeApiError = async (c: Context, next: () => Promise<void>) => {
  await next();
  if (c.res.status < 400 || !c.res.headers.get("content-type")?.includes("application/json")) return;
  const body: unknown = await c.res
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || !("message" in body) || typeof body.message !== "string") return;
  // The platform already localized the manager guard message.
  if ("code" in body && body.code === "LAST_MANAGER") return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify({ ...body, message: contactsApiErrorMessage(c.res.status, getLocale(c), body.message) }), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
};

const requireImportBodySize: MiddlewareHandler<AuthContext> = async (c, next) => {
  const rawLength = c.req.header("content-length");
  if (!rawLength) {
    return respond(c, fail(err.badInput("Import request requires Content-Length"))) as unknown as Response;
  }

  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 0) {
    return respond(c, fail(err.badInput("Invalid Content-Length"))) as unknown as Response;
  }
  if (length > MAX_IMPORT_BODY_BYTES) {
    return respond(c, fail(err.badInput("Import request is too large"))) as unknown as Response;
  }

  return next();
};

const ContactBookSchema = z.object({
  id: ResourceShortIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const ContactBookApiKeySchema = ServiceAccountCredentialSchema.extend({
  permission: z.enum(["none", "read", "write", "admin"]),
});

const CreateContactBookApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  expiresAt: z.string().datetime().nullable().optional(),
  permission: z.enum(["read", "write", "admin"]).default("read"),
});

const CreateContactBookApiKeyResponseSchema = z.object({
  credential: ContactBookApiKeySchema,
  token: z.string(),
});

const ContactEmailSchema = z.object({
  id: z.string(),
  contactId: ResourceShortIdSchema,
  label: z.string().nullable(),
  email: z.email(),
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ContactPhoneSchema = z.object({
  id: z.string(),
  contactId: ResourceShortIdSchema,
  label: z.string().nullable(),
  phone: z.string(),
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ContactWebsiteSchema = z.object({
  id: z.string(),
  contactId: ResourceShortIdSchema,
  label: z.string().nullable(),
  url: z.string(),
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ContactBankAccountSchema = z.object({
  id: z.string(),
  contactId: ResourceShortIdSchema,
  label: z.string().nullable(),
  accountHolderName: z.string(),
  iban: z.string(),
  bic: z.string().nullable(),
  bankName: z.string().nullable(),
  note: z.string().nullable(),
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ContactWebsiteInputSchema = z.object({
  label: z.string().max(100).nullable().optional(),
  url: z.string().trim().min(1).max(500).refine(isSafeWebsiteUrl, "Website URL must start with http:// or https://"),
});

const ContactBankAccountInputSchema = z.object({
  label: z.string().max(100).nullable().optional(),
  accountHolderName: z.string().min(1).max(200),
  iban: z.string().min(1).max(64),
  bic: z.string().max(32).nullable().optional(),
  bankName: z.string().max(200).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

const ContactAddressSchema = z.object({
  id: z.string(),
  contactId: ResourceShortIdSchema,
  label: z.string().nullable(),
  recipientName: z.string().nullable(),
  companyName: z.string().nullable(),
  line1: z.string(),
  line2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  stateRegion: z.string().nullable(),
  countryCode: z.string().length(2),
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ContactRefSchema = z.object({
  id: ResourceShortIdSchema,
  label: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  companyName: z.string().nullable(),
  jobTitle: z.string().nullable(),
});

type ContactTreeNodeApi = z.infer<typeof ContactRefSchema> & {
  parentContactId: string | null;
  children: ContactTreeNodeApi[];
};

const ContactTreeNodeSchema: z.ZodType<ContactTreeNodeApi> = z.lazy(() =>
  ContactRefSchema.extend({
    parentContactId: ResourceShortIdSchema.nullable(),
    children: z.array(ContactTreeNodeSchema),
  }),
);

const ContactTreeSchema = z.object({
  bookId: ResourceShortIdSchema,
  selectedId: ResourceShortIdSchema,
  root: ContactTreeNodeSchema,
});

const ContactSchema = z.object({
  id: ResourceShortIdSchema,
  bookId: ResourceShortIdSchema,
  label: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  companyName: z.string().nullable(),
  department: z.string().nullable(),
  jobTitle: z.string().nullable(),
  vatId: z.string().nullable(),
  birthday: z.string().nullable(),
  salutation: z.string().nullable(),
  pronouns: z.string().nullable(),
  preferredLanguage: z.string().nullable(),
  source: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  emails: z.array(ContactEmailSchema),
  phones: z.array(ContactPhoneSchema),
  addresses: z.array(ContactAddressSchema),
  websites: z.array(ContactWebsiteSchema),
  bankAccounts: z.array(ContactBankAccountSchema),
  parentContactId: ResourceShortIdSchema.nullable(),
  parent: ContactRefSchema.nullable(),
  members: z.array(ContactRefSchema),
  tags: z.array(
    z.object({
      id: ResourceShortIdSchema,
      bookId: ResourceShortIdSchema,
      name: z.string(),
      color: HexColorSchema,
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});

const ContactNoteSchema = z.object({
  id: ResourceShortIdSchema,
  contactId: ResourceShortIdSchema,
  authorUserId: z.string().nullable(),
  authorDisplayName: z.string(),
  authorAvatarHash: z.string().nullable(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
});

const ContactNoteInputSchema = z.object({
  content: z.string().min(1).max(10_000),
});

const ContactNotePageSchema = z.object({
  items: z.array(ContactNoteSchema),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  hasNext: z.boolean(),
});

const ContactTagSchema = z.object({
  id: ResourceShortIdSchema,
  bookId: ResourceShortIdSchema,
  name: z.string(),
  color: HexColorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ContactTagCreateInputSchema = z.object({
  name: z.string().min(1).max(50),
  color: HexColorSchema,
});

const ContactTagUpdateInputSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: HexColorSchema.optional(),
});

const ContactBookSettingsContextSchema = z.object({
  book: ContactBookSchema,
  accessEntries: z.array(AccessEntrySchema),
  apiKeys: z.array(ContactBookApiKeySchema),
  tags: z.array(ContactTagSchema),
});

const ContactEmailInputSchema = z.object({
  label: z.string().max(100).nullable().optional(),
  email: z.email(),
});

const ContactPhoneInputSchema = z.object({
  label: z.string().max(100).nullable().optional(),
  phone: z.string().min(1).max(64),
});

const ContactAddressInputSchema = z.object({
  label: z.string().max(100).nullable().optional(),
  recipientName: z.string().max(200).nullable().optional(),
  companyName: z.string().max(200).nullable().optional(),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullable().optional(),
  postalCode: z.string().min(1).max(32),
  city: z.string().min(1).max(120),
  stateRegion: z.string().max(120).nullable().optional(),
  countryCode: z.string().length(2),
});

const CreateBookSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

const UpdateBookSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
});

const ListBooksQuerySchema = PaginationQuerySchema.extend({
  q: z.string().optional(),
});

const ListContactsQuerySchema = PaginationQuerySchema.extend({
  q: z.string().optional(),
  /** Repeat `tag_id` to filter by multiple tags (OR-mode). */
  tag_id: z.union([z.string(), z.array(z.string())]).optional(),
  sort: z.enum(["name", "updated", "created", "company"]).optional(),
  email: z.enum(["all", "yes", "no"]).optional(),
  phone: z.enum(["all", "yes", "no"]).optional(),
  favorites: z
    .enum(["true"])
    .transform(() => true)
    .optional(),
});

const SearchContactsQuerySchema = PaginationQuerySchema.extend({
  q: z.string().optional(),
  /** Repeat `tag_id` to filter by multiple tags (OR-mode). */
  tag_id: z.union([z.string(), z.array(z.string())]).optional(),
  sort: z.enum(["name", "updated", "created", "company"]).optional(),
  email: z.enum(["all", "yes", "no"]).optional(),
  phone: z.enum(["all", "yes", "no"]).optional(),
  favorites: z
    .enum(["true"])
    .transform(() => true)
    .optional(),
});

const ContactFavoriteSchema = z.object({
  bookId: ResourceShortIdSchema,
  contactId: ResourceShortIdSchema,
  createdAt: z.string(),
});

const SetContactFavoriteSchema = z.object({ favorite: z.boolean() });
const ContactFavoriteStateSchema = z.object({ favorite: z.boolean() });

const ContactIdsSchema = z.array(ResourceShortIdSchema).min(1).max(500);
const BulkContactTagsSchema = z.object({ contactIds: ContactIdsSchema, tagIds: z.array(ResourceShortIdSchema).min(1).max(100) });
const BulkContactMoveSchema = z.object({ contactIds: ContactIdsSchema, targetBookId: ResourceShortIdSchema });
const BulkContactSelectionSchema = z.object({ contactIds: ContactIdsSchema });
const MergeDuplicateSchema = z.object({
  keepId: ResourceShortIdSchema,
  removeId: ResourceShortIdSchema,
  keepUpdatedAt: z.string().datetime(),
  removeUpdatedAt: z.string().datetime(),
});
const BulkContactResultSchema = z.object({ count: z.number().int().positive() });
const ContactDuplicateMatchSchema = z.object({
  first: ContactSchema,
  second: ContactSchema,
  reasons: z.array(z.enum(["email", "phone", "name"])),
});

const CreateContactSchema = z.object({
  label: z.string().max(200).nullable().optional(),
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  companyName: z.string().max(200).nullable().optional(),
  department: z.string().max(200).nullable().optional(),
  jobTitle: z.string().max(200).nullable().optional(),
  vatId: z.string().max(64).nullable().optional(),
  birthday: z.iso.date().nullable().optional(),
  salutation: z.string().max(120).nullable().optional(),
  pronouns: z.string().max(120).nullable().optional(),
  preferredLanguage: z.string().max(35).nullable().optional(),
  source: z.string().max(50).nullable().optional(),
  parentContactId: ResourceShortIdSchema.nullable().optional(),
  tagIds: z.array(ResourceShortIdSchema).optional(),
  emails: z.array(ContactEmailInputSchema).optional(),
  phones: z.array(ContactPhoneInputSchema).optional(),
  addresses: z.array(ContactAddressInputSchema).optional(),
  websites: z.array(ContactWebsiteInputSchema).optional(),
  bankAccounts: z.array(ContactBankAccountInputSchema).optional(),
});

const UpdateContactSchema = z.object({
  label: z.string().max(200).nullable().optional(),
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  companyName: z.string().max(200).nullable().optional(),
  department: z.string().max(200).nullable().optional(),
  jobTitle: z.string().max(200).nullable().optional(),
  vatId: z.string().max(64).nullable().optional(),
  birthday: z.iso.date().nullable().optional(),
  salutation: z.string().max(120).nullable().optional(),
  pronouns: z.string().max(120).nullable().optional(),
  preferredLanguage: z.string().max(35).nullable().optional(),
  source: z.string().max(50).nullable().optional(),
  parentContactId: ResourceShortIdSchema.nullable().optional(),
  tagIds: z.array(ResourceShortIdSchema).optional(),
  emails: z.array(ContactEmailInputSchema).optional(),
  phones: z.array(ContactPhoneInputSchema).optional(),
  addresses: z.array(ContactAddressInputSchema).optional(),
  websites: z.array(ContactWebsiteInputSchema).optional(),
  bankAccounts: z.array(ContactBankAccountInputSchema).optional(),
});

const MoveContactSchema = z.object({
  targetBookId: ResourceShortIdSchema,
});

const ContactBookListResponseSchema = z.object({
  data: z.array(ContactBookSchema),
  pagination: PaginationResponseSchema,
});

const ContactListResponseSchema = z.object({
  data: z.array(ContactSchema),
  pagination: PaginationResponseSchema,
  favoriteKeys: z.array(z.string()),
});

const ImportCommitResponseSchema = z.object({
  created: z.number(),
  failures: z.array(z.string()),
});

const getUserBackedActor = (c: Context<AuthContext>) => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

const requireUserBackedActor = (c: Context<AuthContext>) => {
  const user = getUserBackedActor(c);
  if (!user) return fail(err.forbidden("This endpoint requires a user-backed actor"));
  return ok(user);
};

/** Preserve book errors when a transport step fails before the checking operation runs. */
const failAfterBookAccess = async (c: Context<AuthContext>, checks: { bookId: string; level: PermissionLevel }[], error: ServiceError) => {
  for (const check of checks) {
    const access = await contactsService.book.get({
      id: check.bookId,
      level: check.level,
      actor: c.get("actor"),
      accessSubject: c.get("accessSubject"),
    });
    if (!access.ok) return respond(c, access);
  }
  return respond(c, fail(error));
};

const safeExportFilename = (name: string | null | undefined, extension: "csv" | "vcf"): string => {
  const basename = (name ?? "contacts").replace(/[^a-z0-9-_]+/gi, "_");
  return `${basename}.${extension}`;
};

const resolveContactRelations = async <T extends { parentContactId?: string | null; tagIds?: string[] }>(bookId: string, data: T) => {
  const [parentIds, tagIds] = await Promise.all([
    data.parentContactId ? resolveBookPublicIds("contacts", bookId, [data.parentContactId]) : Promise.resolve([]),
    data.tagIds ? resolveBookPublicIds("tags", bookId, data.tagIds) : Promise.resolve([]),
  ]);
  if (!parentIds || !tagIds) return null;
  return {
    ...data,
    parentContactId: data.parentContactId === null ? null : parentIds[0],
    tagIds,
  };
};

const projectContactPage = async (items: Contact[], favoriteKeys: string[]) => {
  const projected = await projectContacts(items);
  const publicKeys = new Map(
    items.map((item, index) => [`${item.bookId}:${item.id}`, `${projected[index]!.bookId}:${projected[index]!.id}`]),
  );
  return { items: projected, favoriteKeys: favoriteKeys.map((key) => publicKeys.get(key)).filter((key): key is string => Boolean(key)) };
};

const adminApi = new Hono<AuthContext>()
  .use(auth.requireRole("admin"))
  .get("/books/:bookId/access", async (c) => {
    const bookId = c.req.param("bookId") ?? "";
    const internalBookId = await resolvePublicId("books", bookId);
    if (!internalBookId) return respond(c, fail(err.notFound("Book")));
    const book = await contactsService.book.admin.get({ id: internalBookId, actor: c.get("actor") });
    if (!book.ok) return respond(c, book);
    const entries = await contactsService.book.admin.access.list({ bookId: internalBookId!, actor: c.get("actor") });
    return respond(c, entries.ok ? ok(entries.data.items) : entries);
  })
  .post("/books/:bookId/access", v("json", GrantAccessSchema), async (c) => {
    const bookId = c.req.param("bookId") ?? "";
    const { principal, permission } = c.req.valid("json");
    const internalBookId = await resolvePublicId("books", bookId);
    if (!internalBookId) return respond(c, fail(err.notFound("Book")));
    const book = await contactsService.book.admin.get({ id: internalBookId, actor: c.get("actor") });
    if (!book.ok) return respond(c, book);
    return respond(c, contactsService.book.admin.access.grant({ bookId: internalBookId!, principal, permission, actor: c.get("actor") }));
  })
  .patch("/books/:bookId/access/:accessId", v("json", UpdateAccessSchema), async (c) => {
    const bookId = c.req.param("bookId") ?? "";
    const accessId = c.req.param("accessId") ?? "";
    const { permission } = c.req.valid("json");
    const internalBookId = await resolvePublicId("books", bookId);
    if (!internalBookId) return respond(c, fail(err.notFound("Book")));
    const book = await contactsService.book.admin.get({ id: internalBookId, actor: c.get("actor") });
    if (!book.ok) return respond(c, book);

    return respondMessage(
      c,
      contactsService.book.admin.access.update({
        bookId: internalBookId!,
        accessId,
        permission,
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        locale: getLocale(c),
      }),
      "Access updated",
    );
  })
  .delete("/books/:bookId/access/:accessId", async (c) => {
    const bookId = c.req.param("bookId") ?? "";
    const accessId = c.req.param("accessId") ?? "";
    const internalBookId = await resolvePublicId("books", bookId);
    if (!internalBookId) return respond(c, fail(err.notFound("Book")));
    const book = await contactsService.book.admin.get({ id: internalBookId, actor: c.get("actor") });
    if (!book.ok) return respond(c, book);

    return respondMessage(
      c,
      contactsService.book.admin.access.remove({
        bookId: internalBookId!,
        accessId,
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        locale: getLocale(c),
      }),
      "Access revoked",
    );
  });

const RESOURCE_SHORT_ID = /^[0-9A-Za-z]{6}$/;
/** Names and IDs are bounded by the longest stored book name or contact label. */
const ResolveQuerySchema = z
  .object({
    book: z.string().min(1).max(200).optional(),
    contact: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().pipe(z.email().max(320)).optional(),
  })
  .refine((query) => (query.email ? !query.book && !query.contact : Boolean(query.book || query.contact)), {
    message: "Pass book, contact, or email alone",
  });
const ResolveResponseSchema = z.object({ book: ContactBookSchema, contact: ContactSchema.nullable() });
/** Candidates listed in one ambiguity message. */
const RESOLVE_CANDIDATES = 20;

/**
 * Resolves CLI addresses: a book by ID or exact name, a contact by ID or by
 * exact display name inside a book, or the one contact with an email address.
 * Never guesses: several matches fail with 409 and list every candidate.
 * Mounted before `localizeApiError` because its messages are already
 * localized and the candidate list must survive.
 */
const resolveApi = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get(
  "/",
  documentRoute({
    tags: ["Contacts"],
    summary: "Resolve a contact book or contact address",
    description:
      "Pass `book` (ID or exact name) alone for a book, `contact` (ID) alone or with `book` (ID or exact display name) for a contact, or `email` alone for the one readable contact with that address. Several matches return 409 with every candidate.",
    ...requiresAuth,
    responses: {
      ...authResponses,
      200: jsonResponse(ResolveResponseSchema, "The book, and the contact when one was addressed"),
      403: jsonResponse(ErrorResponseSchema, "Access denied"),
      404: jsonResponse(ErrorResponseSchema, "Nothing matches"),
      409: jsonResponse(ErrorResponseSchema, "Several resources match; the message lists them"),
    },
  }),
  v("query", ResolveQuerySchema),
  async (c) => {
    const locale = getLocale(c);
    const t = contactsMessages(locale);
    const query = c.req.valid("query");
    const binding = readableBookScope({ actor: c.get("actor"), accessSubject: c.get("accessSubject") });
    if (!binding.ok) return respond(c, fail(err.forbidden(t.accessDenied)));
    const notFound = (message: string) => respond(c, fail(notFoundError(message)));
    const ambiguous = (value: string, resources: { en: string; de: string }, candidates: { path: string; id: string }[]) =>
      respond(
        c,
        fail({
          code: "CONFLICT" as const,
          status: 409 as const,
          message: localizeCloudCliText(locale, cliAmbiguityText({ value, resources, candidates })),
        }),
      );
    const readable = async (bookId: string) => {
      const access = await contactsService.book.get({ actor: c.get("actor"), accessSubject: c.get("accessSubject"), id: bookId });
      return access.ok ? access.data.book : null;
    };
    const found = async (book: ContactBook, contactId: string | null) => {
      const result = contactId
        ? await contactsService.contact.get({
            actor: c.get("actor"),
            accessSubject: c.get("accessSubject"),
            bookId: book.id,
            id: contactId,
          })
        : null;
      const contact = result?.ok ? result.data : null;
      return respond(c, ok({ book: (await projectBooks([book]))[0]!, contact: contact ? (await projectContacts([contact]))[0]! : null }));
    };

    if (query.email) {
      const result = await contactsService.lookup.resolveContactsByEmail({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        input: { emails: [query.email], limit: RESOLVE_CANDIDATES },
      });
      if (!result.ok) return respond(c, result);
      const [match, ...others] = result.data.items;
      if (!match) return notFound(t.noContactWithEmail({ email: query.email }));
      if (others.length > 0) {
        const items = await projectContactReferences(result.data.items);
        return ambiguous(
          query.email,
          { en: "contacts", de: "Kontakten" },
          items.map((item) => ({ path: `${item.bookName}:${item.displayName}`, id: item.contactId })),
        );
      }
      const book = await readable(match.bookId);
      return book ? found(book, match.contactId) : respond(c, fail(err.forbidden(t.accessDenied)));
    }

    if (!query.book) {
      const contactId = RESOURCE_SHORT_ID.test(query.contact!) ? await resolvePublicId("contacts", query.contact!) : null;
      const bookId = contactId ? await contactsService.contact.findBookId({ id: contactId }) : null;
      if (!contactId || !bookId) return notFound(t.noContactWithId({ ref: query.contact! }));
      const book = await readable(bookId);
      return book ? found(book, contactId) : respond(c, fail(err.forbidden(t.accessDenied)));
    }

    // The book: an ID wins; otherwise the exact name among readable books.
    let book: ContactBook | null = null;
    const bookIdById = RESOURCE_SHORT_ID.test(query.book) ? await resolvePublicId("books", query.book) : null;
    if (bookIdById) {
      book = await readable(bookIdById);
      if (!book) return respond(c, fail(err.forbidden(t.accessDenied)));
    } else {
      const matches = await contactsService.book.findReadableByName({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        name: query.book,
        limit: RESOLVE_CANDIDATES,
      });
      if (!matches.ok) return respond(c, matches);
      if (matches.data.length === 0) return notFound(t.noBookWithRef({ ref: query.book }));
      if (matches.data.length > 1)
        return ambiguous(
          query.book,
          { en: "contact books", de: "Kontaktbüchern" },
          (await projectBooks(matches.data)).map((item) => ({ path: item.name, id: item.id })),
        );
      book = await readable(matches.data[0]!.id);
      if (!book) return respond(c, fail(err.forbidden(t.accessDenied)));
    }
    if (!query.contact) return found(book, null);

    // The contact inside the book: an ID wins; otherwise the exact display name.
    const byId = RESOURCE_SHORT_ID.test(query.contact) ? await resolveBookPublicIds("contacts", book.id, [query.contact]) : null;
    if (byId?.[0]) return found(book, byId[0]);
    const ids = await contactsService.contact.findByDisplayName({ bookId: book.id, name: query.contact, limit: RESOLVE_CANDIDATES });
    if (ids.length === 0) return notFound(t.noContactWithName({ name: query.contact, book: book.name }));
    if (ids.length > 1) {
      const loaded = await contactsService.contact.getMany({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: book.id,
        ids,
      });
      const contacts = loaded.ok ? await projectContacts(loaded.data) : [];
      return ambiguous(
        query.contact,
        { en: "contacts", de: "Kontakten" },
        contacts.map((contact) => ({ path: `${book.name}:${resolveContactName(contact)}`, id: contact.id })),
      );
    }
    return found(book, ids[0]!);
  },
);

/** Contacts API routes for authenticated users and scoped resource credentials. */
const app = new Hono<AuthContext>()
  .route("/live", contactsLive.routes(contactsLiveChannels))
  .route("/ws", legacyLiveRoutes)
  .use(rateLimit())
  .route("/resolve", resolveApi)
  .use(localizeApiError)
  .route("/admin", adminApi)
  .use(auth.requireRole("authenticated"))

  // ----------------------------------------------------------------
  // PERSONAL FAVORITES
  // ----------------------------------------------------------------
  .get(
    "/favorites",
    documentRoute({
      tags: ["Contacts"],
      summary: "List personal contact favorites",
      ...requiresAuth,
      responses: {
        ...authResponses,
        200: jsonResponse(z.array(ContactFavoriteSchema), "Visible personal favorites"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const favorites = await contactsService.favorite.list({ actor: c.get("actor"), accessSubject: c.get("accessSubject") });
      return respond(c, favorites.ok ? ok(await projectFavorites(favorites.data)) : favorites);
    },
  )
  .get(
    "/favorites/:bookId/:contactId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Get personal contact favorite state",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactFavoriteStateSchema, "Favorite state"),
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const [internalContactId] = (await resolveBookPublicIds("contacts", internalBookId!, [contactId])) ?? [];
      if (!internalContactId) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "read" }], err.notFound("Contact"));
      const result = await contactsService.favorite.has({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId,
        contactId: internalContactId,
      });
      return respond(c, result.ok ? ok({ favorite: result.data }) : result);
    },
  )
  .put(
    "/favorites/:bookId/:contactId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Set personal contact favorite state",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(MessageResponseSchema, "Favorite state updated"),
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    v("json", SetContactFavoriteSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const { favorite } = c.req.valid("json");
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const [internalContactId] = (await resolveBookPublicIds("contacts", internalBookId!, [contactId])) ?? [];
      if (!internalContactId) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "read" }], err.notFound("Contact"));
      return respondMessage(
        c,
        contactsService.favorite.set({
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          bookId: internalBookId,
          contactId: internalContactId,
          favorite,
        }),
        "Favorite state updated",
      );
    },
  )

  // ----------------------------------------------------------------
  // BOOKS
  // ----------------------------------------------------------------
  .get(
    "/books",
    documentRoute({
      tags: ["Contacts"],
      summary: "List books",
      description: "List persisted contact books visible to the current actor.",
      ...requiresAuth,
      responses: {
        ...authResponses,
        200: jsonResponse(ContactBookListResponseSchema, "Paginated book list"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("query", ListBooksQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const pagination = parsePagination(query);

      const result = await contactsService.book.list({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        pagination,
        filter: { query: query.q },
      });
      if (!result.ok) return respond(c, result);

      return respond(
        c,
        ok({
          data: await projectBooks(result.data.items),
          pagination: createPagination(pagination, result.data.total),
        }),
      );
    },
  )

  .get(
    "/books/:bookId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Get book",
      description: "Load one contact book by ID.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactBookSchema, "Book details"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const result = await contactsService.book.get({ actor: c.get("actor"), accessSubject: c.get("accessSubject"), id: internalBookId });
      if (!result.ok) return respond(c, result);
      const { book } = result.data;
      return respond(c, ok((await projectBooks([book]))[0]!));
    },
  )

  .get(
    "/books/:bookId/settings-context",
    documentRoute({
      tags: ["Contacts"],
      summary: "Get contact book settings context",
      description: "Load the context required by the lazy contact book settings dialog. Requires admin access to a manual book.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactBookSettingsContextSchema, "Contact book settings context"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);

      const bookId = c.req.param("bookId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));

      const result = await contactsService.book.settingsContext({
        id: internalBookId,
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
      });
      if (!result.ok) return respond(c, result);
      const { book, accessEntries, apiKeys, tags } = result.data;
      return respond(c, ok({ book: (await projectBooks([book]))[0]!, accessEntries, apiKeys, tags: await projectTags(tags) }));
    },
  )

  .post(
    "/books",
    documentRoute({
      tags: ["Contacts"],
      summary: "Create book",
      description: "Create a manual contact book.",
      ...requiresAuth,
      responses: {
        ...authResponses,
        200: jsonResponse(ContactBookSchema, "Created book"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("json", CreateBookSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const data = c.req.valid("json");
      const result = await contactsService.book.create({ data, creatorId: user.id });
      return respond(c, result.ok ? ok((await projectBooks([result.data]))[0]!) : result);
    },
  )

  .patch(
    "/books/:bookId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Update book",
      description: "Update one manual contact book. Requires admin book access.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactBookSchema, "Updated book"),
      },
    }),
    v("json", UpdateBookSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const data = c.req.valid("json");

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const result = await contactsService.book.update({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        id: internalBookId!,
        data,
      });
      return respond(c, result.ok ? ok((await projectBooks([result.data]))[0]!) : result);
    },
  )

  .delete(
    "/books/:bookId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Delete book",
      description: "Delete one manual contact book. Requires admin book access.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(MessageResponseSchema, "Book deleted"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      return respondMessage(
        c,
        contactsService.book.remove({ actor: c.get("actor"), accessSubject: c.get("accessSubject"), id: internalBookId! }),
        "Book deleted",
      );
    },
  )

  // ----------------------------------------------------------------
  // BOOK ACCESS (ACL)
  // ----------------------------------------------------------------
  .get(
    "/books/:bookId/access",
    documentRoute({
      tags: ["Contacts"],
      summary: "List book access entries",
      description: "List all access entries for a manual book. Requires admin book access.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(z.array(AccessEntrySchema), "Access entries"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));

      const entries = await contactsService.book.access.list({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
      });
      return respond(c, entries.ok ? ok(entries.data.items) : entries);
    },
  )

  .post(
    "/books/:bookId/access",
    documentRoute({
      tags: ["Contacts"],
      summary: "Grant book access",
      description: "Grant access to a user, group, or public principal for a manual book. Requires admin book access.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(AccessEntrySchema, "Created access entry"),
        404: jsonResponse(ErrorResponseSchema, "Book or principal not found"),
        409: jsonResponse(ErrorResponseSchema, "Principal already has access"),
      },
    }),
    v("json", GrantAccessSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const { principal, permission } = c.req.valid("json");

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));

      return respond(
        c,
        contactsService.book.access.grant({
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          bookId: internalBookId!,
          principal,
          permission,
        }),
      );
    },
  )

  .patch(
    "/books/:bookId/access/:accessId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Update book access permission",
      description: "Update one access permission for a manual book. Requires admin book access.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(MessageResponseSchema, "Access updated"),
        409: jsonResponse(ErrorResponseSchema, "The change would leave the book without a manager (LAST_MANAGER)"),
        404: jsonResponse(ErrorResponseSchema, "Book or access entry not found"),
      },
    }),
    v("json", UpdateAccessSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const accessId = c.req.param("accessId") ?? "";
      const { permission } = c.req.valid("json");

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));

      if (!isUuid(accessId))
        return failAfterBookAccess(c, [{ bookId: internalBookId, level: "admin" }], err.notFound("Book or access entry"));
      return respondMessage(
        c,
        contactsService.book.access.update({
          bookId: internalBookId!,
          accessId,
          permission,
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          locale: getLocale(c),
        }),
        "Access updated",
      );
    },
  )

  .delete(
    "/books/:bookId/access/:accessId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Revoke book access",
      description: "Delete one access entry from a manual book. Requires admin book access.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(MessageResponseSchema, "Access revoked"),
        400: jsonResponse(ErrorResponseSchema, "Cannot remove the last access entry"),
        409: jsonResponse(ErrorResponseSchema, "The change would leave the book without a manager (LAST_MANAGER)"),
        404: jsonResponse(ErrorResponseSchema, "Book or access entry not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const accessId = c.req.param("accessId") ?? "";

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));

      if (!isUuid(accessId))
        return failAfterBookAccess(c, [{ bookId: internalBookId, level: "admin" }], err.notFound("Book or access entry"));
      return respondMessage(
        c,
        contactsService.book.access.remove({
          bookId: internalBookId!,
          accessId,
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          locale: getLocale(c),
        }),
        "Access revoked",
      );
    },
  )

  // ----------------------------------------------------------------
  // BOOK API KEYS
  // ----------------------------------------------------------------
  .get(
    "/books/:bookId/api-keys",
    documentRoute({
      tags: ["Contacts"],
      summary: "List contact book API keys",
      description: "List active resource-bound API keys for this contact book. Requires admin book access.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(z.object({ items: z.array(ContactBookApiKeySchema) }), "Contact book API keys"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));

      const result = await contactsService.book.access.apiKeys.list({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId,
      });
      return respond(c, result.ok ? ok({ items: result.data }) : result);
    },
  )

  .post(
    "/books/:bookId/api-keys",
    // A resource API key outlives the phone: the mobile app cannot create one.
    auth.rejectAppSession,
    documentRoute({
      tags: ["Contacts"],
      summary: "Create contact book API key",
      description: "Create a resource-bound API key for this contact book. The raw token is returned once. Requires admin book access.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        201: jsonResponse(CreateContactBookApiKeyResponseSchema, "Contact book API key created"),
        400: jsonResponse(ErrorResponseSchema, "Failed to create API key"),
      },
    }),
    v("json", CreateContactBookApiKeySchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const data = c.req.valid("json");

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));

      return respond(
        c,
        contactsService.book.access.apiKeys.create({
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          bookId: internalBookId!,
          data: {
            name: data.name,
            expiresAt: data.expiresAt ?? null,
            permission: data.permission,
          },
        }),
        201,
      );
    },
  )

  .delete(
    "/books/:bookId/api-keys/:credentialId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Revoke contact book API key",
      description: "Revoke a resource-bound API key for this contact book. Requires admin book access.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(MessageResponseSchema, "Contact book API key revoked"),
        404: jsonResponse(ErrorResponseSchema, "Book or API key not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const credentialId = c.req.param("credentialId") ?? "";

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));

      return respond(
        c,
        contactsService.book.access.apiKeys.revoke({
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          bookId: internalBookId!,
          credentialId,
        }),
      );
    },
  )

  // ----------------------------------------------------------------
  // CONTACTS
  // ----------------------------------------------------------------
  .get(
    "/books/:bookId/contacts",
    documentRoute({
      tags: ["Contacts"],
      summary: "List contacts",
      description: "List contacts in a book with pagination and optional search filter.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactListResponseSchema, "Paginated contacts"),
        403: jsonResponse(ErrorResponseSchema, "Access denied or favorites require a user-backed actor"),
        404: jsonResponse(ErrorResponseSchema, "Book or tag not found"),
      },
    }),
    v("query", ListContactsQuerySchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const query = c.req.valid("query");
      const pagination = parsePagination(query);

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));

      const publicTagIds = Array.isArray(query.tag_id) ? query.tag_id : query.tag_id ? [query.tag_id] : undefined;
      const resolvedTagIds = publicTagIds ? await resolveBookPublicIds("tags", internalBookId!, publicTagIds) : undefined;
      if (publicTagIds && !resolvedTagIds) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "read" }], err.notFound("Tag"));
      const tagIds = resolvedTagIds ?? undefined;
      const user = getUserBackedActor(c);
      if (query.favorites && !user)
        return failAfterBookAccess(c, [{ bookId: internalBookId, level: "read" }], err.forbidden("Favorites require a user-backed actor"));
      const result = await contactsService.contact.list({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        pagination,
        filter: {
          query: query.q,
          tagIds,
          sort: query.sort,
          email: query.email,
          phone: query.phone,
          favoriteUserId: query.favorites ? user?.id : undefined,
        },
      });
      if (!result.ok) return respond(c, result);
      const favoriteKeys = await contactsService.favorite.listKeysForContacts({ actor: c.get("actor"), contacts: result.data.items });
      const projected = await projectContactPage(result.data.items, favoriteKeys);

      return respond(
        c,
        ok({
          data: projected.items,
          pagination: createPagination(pagination, result.data.total),
          favoriteKeys: projected.favoriteKeys,
        }),
      );
    },
  )

  .get(
    "/books/:bookId/contacts/duplicates",
    documentRoute({
      tags: ["Contacts"],
      summary: "Find duplicate contacts",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(z.array(ContactDuplicateMatchSchema), "Duplicate candidates"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const result = await contactsService.contact.duplicates.list({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
      });
      return respond(c, result.ok ? ok(await projectDuplicates(result.data)) : result);
    },
  )

  .post(
    "/books/:bookId/contacts/duplicates/merge",
    documentRoute({
      tags: ["Contacts"],
      summary: "Merge duplicate contacts",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactSchema, "Merged contact"),
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    v("json", MergeDuplicateSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const data = c.req.valid("json");
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [data.keepId, data.removeId]);
      if (!ids) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Contact"));
      const result = await contactsService.contact.duplicates.merge({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        keepId: ids[0]!,
        removeId: ids[1]!,
        keepUpdatedAt: data.keepUpdatedAt,
        removeUpdatedAt: data.removeUpdatedAt,
      });
      return respond(c, result.ok ? ok((await projectContacts([result.data]))[0]!) : result);
    },
  )

  .post(
    "/books/:bookId/contacts/bulk/tags",
    documentRoute({
      tags: ["Contacts"],
      summary: "Add tags to contacts",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(BulkContactResultSchema, "Updated contact count"),
        404: jsonResponse(ErrorResponseSchema, "Book, contact, or tag not found"),
      },
    }),
    v("json", BulkContactTagsSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { contactIds, tagIds } = c.req.valid("json");
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const [ids, internalTagIds] = await Promise.all([
        resolveBookPublicIds("contacts", internalBookId!, contactIds),
        resolveBookPublicIds("tags", internalBookId!, tagIds),
      ]);
      if (!ids || !internalTagIds)
        return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Contact or tag"));
      const result = await contactsService.contact.bulk.addTags({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        ids,
        tagIds: internalTagIds,
      });
      return respond(c, result.ok ? ok({ count: result.data }) : result);
    },
  )

  .post(
    "/books/:bookId/contacts/bulk/move",
    documentRoute({
      tags: ["Contacts"],
      summary: "Move contacts to another book",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(BulkContactResultSchema, "Moved contact count"),
        404: jsonResponse(ErrorResponseSchema, "Source book, target book, or contact not found"),
      },
    }),
    v("json", BulkContactMoveSchema),
    async (c) => {
      const sourceBookId = c.req.param("bookId") ?? "";
      const { contactIds, targetBookId } = c.req.valid("json");
      const internalSourceBookId = await resolvePublicId("books", sourceBookId);
      if (!internalSourceBookId) return respond(c, fail(err.notFound("Book")));
      const internalTargetBookId = await resolvePublicId("books", targetBookId);
      if (!internalTargetBookId) return failAfterBookAccess(c, [{ bookId: internalSourceBookId, level: "write" }], err.notFound("Book"));
      const ids = await resolveBookPublicIds("contacts", internalSourceBookId!, contactIds);
      if (!ids)
        return failAfterBookAccess(
          c,
          [
            { bookId: internalSourceBookId, level: "write" },
            { bookId: internalTargetBookId, level: "write" },
          ],
          err.notFound("Contact"),
        );
      const result = await contactsService.contact.bulk.move({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        sourceBookId: internalSourceBookId!,
        targetBookId: internalTargetBookId!,
        ids,
      });
      return respond(c, result.ok ? ok({ count: result.data }) : result);
    },
  )

  .post(
    "/books/:bookId/contacts/bulk/delete",
    documentRoute({
      tags: ["Contacts"],
      summary: "Delete contacts",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(BulkContactResultSchema, "Deleted contact count"),
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    v("json", BulkContactSelectionSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { contactIds } = c.req.valid("json");
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const ids = await resolveBookPublicIds("contacts", internalBookId!, contactIds);
      if (!ids) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Contact"));
      const result = await contactsService.contact.bulk.remove({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        ids,
      });
      return respond(c, result.ok ? ok({ count: result.data }) : result);
    },
  )

  .post(
    "/books/:bookId/contacts/bulk/export.vcf",
    documentRoute({
      tags: ["Contacts"],
      summary: "Export selected contacts as vCard",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: { description: "vCard file" },
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    v("json", BulkContactSelectionSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { contactIds } = c.req.valid("json");
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const bookResult = await contactsService.book.get({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        id: internalBookId,
      });
      if (!bookResult.ok) return respond(c, bookResult);
      const { book } = bookResult.data;
      const ids = await resolveBookPublicIds("contacts", internalBookId!, contactIds);
      if (!ids) return respond(c, fail(err.notFound("Contact")));
      const result = await contactsService.contact.getMany({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        ids,
      });
      if (!result.ok) return respond(c, result);
      return c.body(vcard.serializeBook(result.data), 200, {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeExportFilename(`${book?.name ?? "contacts"}-selection`, "vcf")}"`,
      });
    },
  )

  .get(
    "/books/:bookId/contacts/:contactId/export.vcf",
    documentRoute({
      tags: ["Contacts"],
      summary: "Export contact as vCard",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: { description: "vCard file" },
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!ids) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "read" }], err.notFound("Contact"));
      const result = await contactsService.contact.get({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        id: ids[0]!,
      });
      if (!result.ok) return respond(c, result);
      const contact = result.data;
      if (!contact) return respond(c, fail(err.notFound("Contact")));
      return c.body(`${vcard.serializeContact(contact)}\r\n`, 200, {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeExportFilename(resolveContactName(contact), "vcf")}"`,
      });
    },
  )

  .get(
    "/books/:bookId/contacts/:contactId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Get contact",
      description: "Load one contact from a specific book.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactSchema, "Contact"),
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!ids) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "read" }], err.notFound("Contact"));
      const result = await contactsService.contact.get({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        id: ids[0]!,
        bookId: internalBookId!,
      });
      if (!result.ok) return respond(c, result);
      const contact = result.data;
      if (!contact) {
        return respond(c, fail(err.notFound("Contact")));
      }

      return respond(c, ok((await projectContacts([contact]))[0]!));
    },
  )

  .get(
    "/books/:bookId/contacts/:contactId/tree",
    documentRoute({
      tags: ["Contacts"],
      summary: "Get contact tree",
      description: "Load the full hierarchy around one manual contact in a specific book.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactTreeSchema, "Contact hierarchy tree"),
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!ids) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "read" }], err.notFound("Contact tree"));
      const result = await contactsService.contact.tree({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        id: ids[0]!,
        bookId: internalBookId!,
      });
      if (!result.ok) return respond(c, result);
      const contactTree = result.data;
      if (!contactTree) {
        return respond(c, fail(err.notFound("Contact tree")));
      }

      return respond(c, ok((await projectTrees([contactTree]))[0]!));
    },
  )

  .post(
    "/books/:bookId/contacts",
    documentRoute({
      tags: ["Contacts"],
      summary: "Create contact",
      description: "Create one contact with optional emails/phones/addresses.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactSchema, "Created contact"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        404: jsonResponse(ErrorResponseSchema, "Book, parent contact, or tag not found"),
      },
    }),
    v("json", CreateContactSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const data = c.req.valid("json");

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const internalData = await resolveContactRelations(internalBookId!, data);
      if (!internalData) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Parent contact or tag"));
      const result = await contactsService.contact.create({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        data: internalData,
      });
      return respond(c, result.ok ? ok((await projectContacts([result.data]))[0]!) : result);
    },
  )

  .patch(
    "/books/:bookId/contacts/:contactId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Update contact",
      description: "Update one contact. Provided child arrays fully replace existing entries.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactSchema, "Updated contact"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        404: jsonResponse(ErrorResponseSchema, "Book, contact, parent contact, or tag not found"),
      },
    }),
    v("json", UpdateContactSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const data = c.req.valid("json");

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      const internalData = await resolveContactRelations(internalBookId!, data);
      if (!ids || !internalData)
        return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Contact, parent contact, or tag"));
      const result = await contactsService.contact.update({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        id: ids[0]!,
        data: internalData,
      });
      return respond(c, result.ok ? ok((await projectContacts([result.data]))[0]!) : result);
    },
  )

  .post(
    "/books/:bookId/contacts/:contactId/move",
    documentRoute({
      tags: ["Contacts"],
      summary: "Move contact",
      description: "Move one contact from the current manual book to another writable manual book.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactSchema, "Moved contact"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        404: jsonResponse(ErrorResponseSchema, "Source book, target book, or contact not found"),
      },
    }),
    v("json", MoveContactSchema),
    async (c) => {
      const sourceBookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const { targetBookId } = c.req.valid("json");

      const internalSourceBookId = await resolvePublicId("books", sourceBookId);
      if (!internalSourceBookId) return respond(c, fail(err.notFound("Book")));

      const internalTargetBookId = await resolvePublicId("books", targetBookId);
      if (!internalTargetBookId) return failAfterBookAccess(c, [{ bookId: internalSourceBookId, level: "write" }], err.notFound("Book"));
      if (internalSourceBookId === internalTargetBookId) {
        return failAfterBookAccess(
          c,
          [
            { bookId: internalSourceBookId, level: "write" },
            { bookId: internalTargetBookId, level: "write" },
          ],
          err.badInput("Choose another contact book"),
        );
      }
      const ids = await resolveBookPublicIds("contacts", internalSourceBookId!, [contactId]);
      if (!ids)
        return failAfterBookAccess(
          c,
          [
            { bookId: internalSourceBookId, level: "write" },
            { bookId: internalTargetBookId, level: "write" },
          ],
          err.notFound("Contact"),
        );
      const result = await contactsService.contact.move({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        sourceBookId: internalSourceBookId!,
        targetBookId: internalTargetBookId!,
        id: ids[0]!,
      });
      return respond(c, result.ok ? ok((await projectContacts([result.data]))[0]!) : result);
    },
  )

  .delete(
    "/books/:bookId/contacts/:contactId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Delete contact",
      description: "Delete one contact from the selected book.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(MessageResponseSchema, "Contact deleted"),
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!ids) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Contact"));
      return respondMessage(
        c,
        contactsService.contact.remove({
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          bookId: internalBookId!,
          id: ids[0]!,
        }),
        "Contact deleted",
      );
    },
  )

  // ----------------------------------------------------------------
  // CONTACT NOTES (timeline)
  // ----------------------------------------------------------------
  .get(
    "/books/:bookId/contacts/:contactId/notes/page",
    documentRoute({
      tags: ["Contacts"],
      summary: "List a page of contact notes",
      description: "Returns a bounded page of notes attached to one contact, newest first.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactNotePageSchema, "Paginated notes timeline"),
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    v("query", PaginationQuerySchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const contactIds = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!contactIds) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "read" }], err.notFound("Contact"));
      const page = await contactsService.contact.notes.listPage({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        contactId: contactIds[0]!,
        pagination: parsePagination(c.req.valid("query")),
      });
      return respond(c, page.ok ? ok({ ...page.data, items: await projectNotes(page.data.items) }) : page);
    },
  )
  .get(
    "/books/:bookId/contacts/:contactId/notes",
    documentRoute({
      tags: ["Contacts"],
      summary: "List contact notes",
      description: "Returns the timeline of notes attached to one contact, newest first.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(z.array(ContactNoteSchema), "Notes timeline"),
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const contactIds = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!contactIds) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "read" }], err.notFound("Contact"));
      const notes = await contactsService.contact.notes.list({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        contactId: contactIds[0]!,
      });
      return respond(c, notes.ok ? ok(await projectNotes(notes.data)) : notes);
    },
  )
  .post(
    "/books/:bookId/contacts/:contactId/notes",
    documentRoute({
      tags: ["Contacts"],
      summary: "Add a note to a contact",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactNoteSchema, "Created note"),
        400: jsonResponse(ErrorResponseSchema, "Validation error"),
        404: jsonResponse(ErrorResponseSchema, "Book or contact not found"),
      },
    }),
    v("json", ContactNoteInputSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const data = c.req.valid("json");
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const contactIds = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!contactIds) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Contact"));
      const result = await contactsService.contact.notes.create({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        contactId: contactIds[0]!,
        data,
      });
      return respond(c, result.ok ? ok((await projectNotes([result.data]))[0]!) : result);
    },
  )
  .patch(
    "/books/:bookId/contacts/:contactId/notes/:noteId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Update one note",
      description: "Only the original author may edit their own note within 10 minutes.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactNoteSchema, "Updated note"),
        403: jsonResponse(ErrorResponseSchema, "Access denied or not the note's author"),
        404: jsonResponse(ErrorResponseSchema, "Book, contact, or note not found"),
      },
    }),
    v("json", ContactNoteInputSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const noteId = c.req.param("noteId") ?? "";
      const data = c.req.valid("json");
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const [contactIds, internalNoteId] = await Promise.all([
        resolveBookPublicIds("contacts", internalBookId!, [contactId]),
        resolvePublicId("notes", noteId),
      ]);
      if (!contactIds || !internalNoteId)
        return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Contact note"));
      const result = await contactsService.contact.notes.update({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        contactId: contactIds[0]!,
        noteId: internalNoteId,
        data,
      });
      return respond(c, result.ok ? ok((await projectNotes([result.data]))[0]!) : result);
    },
  )
  .delete(
    "/books/:bookId/contacts/:contactId/notes/:noteId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Delete one note",
      description: "Only the original author may delete their own note within 10 minutes.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(MessageResponseSchema, "Note deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied or not the note's author"),
        404: jsonResponse(ErrorResponseSchema, "Book, contact, or note not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const noteId = c.req.param("noteId") ?? "";
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);

      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const [contactIds, internalNoteId] = await Promise.all([
        resolveBookPublicIds("contacts", internalBookId!, [contactId]),
        resolvePublicId("notes", noteId),
      ]);
      if (!contactIds || !internalNoteId)
        return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Contact note"));

      return respondMessage(
        c,
        contactsService.contact.notes.remove({
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          bookId: internalBookId!,
          contactId: contactIds[0]!,
          noteId: internalNoteId,
        }),
        "Note deleted",
      );
    },
  )

  // ----------------------------------------------------------------
  // TAGS (per book)
  // ----------------------------------------------------------------
  .get(
    "/books/:bookId/tags",
    documentRoute({
      tags: ["Contacts"],
      summary: "List tags for a book",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(z.array(ContactTagSchema), "Tags"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const items = await contactsService.tag.list({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
      });
      return respond(c, items.ok ? ok(await projectTags(items.data)) : items);
    },
  )
  .post(
    "/books/:bookId/tags",
    documentRoute({
      tags: ["Contacts"],
      summary: "Create a tag",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactTagSchema, "Created tag"),
        409: jsonResponse(ErrorResponseSchema, "Name already exists"),
      },
    }),
    v("json", ContactTagCreateInputSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const data = c.req.valid("json");
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const result = await contactsService.tag.create({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        data,
      });
      return respond(c, result.ok ? ok((await projectTags([result.data]))[0]!) : result);
    },
  )
  .patch(
    "/books/:bookId/tags/:tagId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Update a tag",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ContactTagSchema, "Updated tag"),
        404: jsonResponse(ErrorResponseSchema, "Book or tag not found"),
      },
    }),
    v("json", ContactTagUpdateInputSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const tagId = c.req.param("tagId") ?? "";
      const data = c.req.valid("json");
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const ids = await resolveBookPublicIds("tags", internalBookId!, [tagId]);
      if (!ids) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Tag"));
      const result = await contactsService.tag.update({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId!,
        id: ids[0]!,
        data,
      });
      return respond(c, result.ok ? ok((await projectTags([result.data]))[0]!) : result);
    },
  )
  .delete(
    "/books/:bookId/tags/:tagId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Delete a tag",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(MessageResponseSchema, "Tag deleted"),
        404: jsonResponse(ErrorResponseSchema, "Book or tag not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const tagId = c.req.param("tagId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const ids = await resolveBookPublicIds("tags", internalBookId!, [tagId]);
      if (!ids) return failAfterBookAccess(c, [{ bookId: internalBookId, level: "write" }], err.notFound("Tag"));
      return respondMessage(
        c,
        contactsService.tag.remove({ actor: c.get("actor"), accessSubject: c.get("accessSubject"), bookId: internalBookId!, id: ids[0]! }),
        "Tag deleted",
      );
    },
  )

  // ----------------------------------------------------------------
  // IMPORT / EXPORT
  // ----------------------------------------------------------------
  .get(
    "/books/:bookId/export.vcf",
    documentRoute({
      tags: ["Contacts"],
      summary: "Export book as vCard",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: { description: "vCard file" },
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const result = await contactsService.contact.exportPages({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId,
      });
      if (!result.ok) return respond(c, result);
      const { book, pages } = result.data;
      const body = exportBody(pages, vcard.serializeBookPage, { bookId: internalBookId!, format: "vcf", signal: c.req.raw.signal });
      return c.body(body, 200, {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeExportFilename(book?.name, "vcf")}"`,
      });
    },
  )
  .get(
    "/books/:bookId/export.csv",
    documentRoute({
      tags: ["Contacts"],
      summary: "Export book as CSV (flat — first email/phone/address only)",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: { description: "CSV file" },
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const result = await contactsService.contact.exportPages({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        bookId: internalBookId,
      });
      if (!result.ok) return respond(c, result);
      const { book, pages } = result.data;
      const body = exportBody(pages, vcard.serializeCsvRows, {
        bookId: internalBookId!,
        format: "csv",
        signal: c.req.raw.signal,
        header: vcard.CSV_HEADER_LINE,
      });
      return c.body(body, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeExportFilename(book?.name, "csv")}"`,
      });
    },
  )
  .post(
    "/books/:bookId/import/preview",
    documentRoute({
      tags: ["Contacts"],
      summary: "Parse a vCard payload and preview matches against existing contacts",
      description:
        "Returns the parsed candidates plus a match indicator (by email or by first+last name) so the client can present a checkbox list before commit.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(z.object({ candidates: z.array(z.unknown()) }), "Preview"),
      },
    }),
    requireImportBodySize,
    v(
      "json",
      z.object({
        format: z.enum(["vcard"]),
        content: z.string().min(1).max(MAX_IMPORT_CONTENT_CHARS),
      }),
    ),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const body = c.req.valid("json");
      return respond(
        c,
        contactsService.import.preview({
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          bookId: internalBookId!,
          content: body.content,
        }),
      );
    },
  )
  .post(
    "/books/:bookId/import/commit",
    documentRoute({
      tags: ["Contacts"],
      summary: "Bulk create contacts from a previously previewed candidate list",
      description:
        "Caller passes back the candidates that should be created. The server creates them in order and returns the created ids.",
      ...requiresAuth,
      responses: {
        ...bookScopedResponses,
        200: jsonResponse(ImportCommitResponseSchema, "Created count with per-contact failures"),
      },
    }),
    requireImportBodySize,
    v(
      "json",
      z.object({
        contacts: z.array(z.unknown()).max(MAX_IMPORT_CONTACTS),
      }),
    ),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const internalBookId = await resolvePublicId("books", bookId);
      if (!internalBookId) return respond(c, fail(err.notFound("Book")));
      const body = c.req.valid("json");
      return respond(
        c,
        contactsService.import.commit({
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          bookId: internalBookId!,
          candidates: body.contacts,
          validateCandidate: (candidate) => {
            const parsed = CreateContactSchema.safeParse(candidate);
            return parsed.success ? ok(parsed.data) : fail(err.badInput(parsed.error.message));
          },
        }),
      );
    },
  )

  // ----------------------------------------------------------------
  // GLOBAL SEARCH
  // ----------------------------------------------------------------
  .get(
    "/search",
    documentRoute({
      tags: ["Contacts"],
      summary: "Search contacts",
      description: "Search across all readable contact books, returning paginated matches.",
      ...requiresAuth,
      responses: {
        ...authResponses,
        200: jsonResponse(ContactListResponseSchema, "Search results"),
        403: jsonResponse(ErrorResponseSchema, "Access denied or favorites require a user-backed actor"),
        404: jsonResponse(ErrorResponseSchema, "Tag not found"),
      },
    }),
    v("query", SearchContactsQuerySchema),
    async (c) => {
      const scope = readableBookScope({ actor: c.get("actor"), accessSubject: c.get("accessSubject") });
      if (!scope.ok) return respond(c, scope);
      const query = c.req.valid("query");
      const pagination = parsePagination(query);
      const user = getUserBackedActor(c);
      const publicTagIds = Array.isArray(query.tag_id) ? query.tag_id : query.tag_id ? [query.tag_id] : undefined;
      const resolvedTagIds = publicTagIds ? await resolvePublicIds("tags", publicTagIds) : undefined;
      if (publicTagIds && !resolvedTagIds) return respond(c, fail(err.notFound("Tag")));
      const tagIds = resolvedTagIds ?? undefined;
      if (query.favorites && !user) return respond(c, fail(err.forbidden("Favorites require a user-backed actor")));
      const result = await contactsService.contact.search({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        pagination,
        filter: {
          query: query.q,
          tagIds,
          sort: query.sort,
          email: query.email,
          phone: query.phone,
          favoriteUserId: query.favorites ? user?.id : undefined,
        },
      });
      if (!result.ok) return respond(c, result);
      const favoriteKeys = await contactsService.favorite.listKeysForContacts({ actor: c.get("actor"), contacts: result.data.items });
      const projected = await projectContactPage(result.data.items, favoriteKeys);

      return respond(
        c,
        ok({
          data: projected.items,
          pagination: createPagination(pagination, result.data.total),
          favoriteKeys: projected.favoriteKeys,
        }),
      );
    },
  );

export default app;
export type ApiType = typeof app;
