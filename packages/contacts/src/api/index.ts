import { err, fail, ok } from "@k2b/stdlib";
import {
  AccessEntrySchema,
  createPagination,
  ErrorResponseSchema,
  GrantAccessSchema,
  hasRole,
  MessageResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  type PermissionLevel,
  parsePagination,
  ServiceAccountCredentialSchema,
  UpdateAccessSchema,
} from "@valentinkolb/cloud/contracts";
import {
  type AuthContext,
  auth,
  getLocale,
  hasPermission,
  jsonResponse,
  rateLimit,
  requiresAuth,
  respond,
  respondMessage,
  v,
} from "@valentinkolb/cloud/server";
import { type Context, Hono, type MiddlewareHandler, type TypedResponse } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ResourceShortIdSchema } from "../capability-contracts";
import { contactsService } from "../service";
import { CONTACT_BOOK_RESOURCE_TYPE, CONTACTS_APP_ID } from "../service/access";
import { contactsApiErrorMessage } from "../service/messages";
import {
  projectBooks,
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
import * as vcard from "../service/vcard";
import { isSafeWebsiteUrl, resolveContactName } from "../shared";
import wsRoutes from "../ws";

const documentRoute = (options: Parameters<typeof describeRoute>[0]) => describeRoute(options) as MiddlewareHandler<AuthContext>;

type ApiErrorResponse = TypedResponse<{ message: string; code?: string }, 400 | 401 | 403 | 404 | 409 | 500, "json">;
const MAX_IMPORT_CONTACTS = contactsService.import.MAX_IMPORT_CONTACTS;
const MAX_IMPORT_CONTENT_CHARS = contactsService.import.MAX_IMPORT_CONTENT_CHARS;
const MAX_IMPORT_BODY_BYTES = contactsService.import.MAX_IMPORT_BODY_BYTES;
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be a #RRGGBB hex value");

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const permissionFromScopes = (scopes: string[]): PermissionLevel => {
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return "none";
};

const minPermission = (a: PermissionLevel, b: PermissionLevel): PermissionLevel => (PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b);

const localizeApiError = async (c: Context, next: () => Promise<void>) => {
  await next();
  if (c.res.status < 400 || !c.res.headers.get("content-type")?.includes("application/json")) return;
  const body: unknown = await c.res
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || !("message" in body) || typeof body.message !== "string") return;
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

const getBookAccessSubject = (c: Context<AuthContext>) => {
  const user = getUserBackedActor(c);
  const accessSubject = c.get("accessSubject");
  const actor = c.get("actor");
  const serviceAccount = actor.kind === "service_account" ? actor.serviceAccount : null;
  return {
    user,
    subject: accessSubject,
    serviceAccountId: accessSubject.type === "service_account" ? accessSubject.serviceAccountId : null,
    serviceAccount,
    serviceAccountScopes: actor.kind === "service_account" ? actor.scopes : [],
  };
};

/**
 * Restricts collection endpoints to the exact resource bound to an API key.
 * Detail endpoints enforce the same invariant in `requireBookAccess`.
 */
const requireReadableCollectionBinding = async (c: Context<AuthContext>, subject: ReturnType<typeof getBookAccessSubject>) => {
  if (!subject.serviceAccountId) {
    return { boundBookId: null, error: null as ApiErrorResponse | null };
  }

  const account = subject.serviceAccount;
  if (
    account?.kind !== "resource_bound" ||
    account.appId !== CONTACTS_APP_ID ||
    account.resourceType !== CONTACT_BOOK_RESOURCE_TYPE ||
    !account.resourceId ||
    !isUuid(account.resourceId) ||
    !hasPermission(permissionFromScopes(subject.serviceAccountScopes), "read")
  ) {
    return {
      boundBookId: null,
      error: await respond(c, fail(err.forbidden("Access denied"))),
    };
  }

  return { boundBookId: account.resourceId, error: null as ApiErrorResponse | null };
};

/**
 * Resolves one book and checks required permissions for the current actor.
 */
const requireBookAccess = async (c: Context<AuthContext>, publicBookId: string, requiredLevel: PermissionLevel = "read") => {
  const subject = getBookAccessSubject(c);
  const bookId = await resolvePublicId("books", publicBookId);
  if (!bookId) {
    return { book: null, bookId: null, error: await respond(c, fail(err.notFound("Book"))) };
  }
  const book = await contactsService.book.get({ id: bookId });

  if (!book) {
    return {
      book: null,
      bookId: null,
      error: await respond(c, fail(err.notFound("Book"))),
    };
  }

  if (subject.user && hasRole(subject.user, "admin")) {
    return { book, bookId, permission: "admin" as PermissionLevel, user: subject.user, error: null as ApiErrorResponse | null };
  }

  if (
    subject.serviceAccount?.kind === "resource_bound" &&
    (subject.serviceAccount.appId !== CONTACTS_APP_ID ||
      subject.serviceAccount.resourceType !== CONTACT_BOOK_RESOURCE_TYPE ||
      subject.serviceAccount.resourceId !== bookId)
  ) {
    return {
      book: null,
      bookId: null,
      permission: "none" as PermissionLevel,
      user: subject.user,
      error: await respond(c, fail(err.forbidden("Access denied"))),
    };
  }

  let permission = await contactsService.book.permission.get({
    bookId,
    subject: subject.subject,
  });

  if (subject.serviceAccount?.kind === "resource_bound") {
    permission = minPermission(permission, permissionFromScopes(subject.serviceAccountScopes));
  }

  if (!hasPermission(permission, requiredLevel)) {
    return {
      book: null,
      bookId: null,
      permission: "none" as PermissionLevel,
      user: subject.user,
      error: await respond(c, fail(err.forbidden("Access denied"))),
    };
  }

  return { book, bookId, permission, user: subject.user, error: null as ApiErrorResponse | null };
};

const requireBookAdminOrAppAdmin = async (c: Context<AuthContext>, publicBookId: string) => {
  const user = getUserBackedActor(c);
  const bookId = await resolvePublicId("books", publicBookId);
  if (!bookId) return { book: null, bookId: null, error: await respond(c, fail(err.notFound("Book"))) };
  const book = await contactsService.book.get({ id: bookId });

  if (!book) {
    return {
      book: null,
      bookId: null,
      error: await respond(c, fail(err.notFound("Book"))),
    };
  }

  if (user && hasRole(user, "admin")) return { book, bookId, error: null as ApiErrorResponse | null };
  return requireBookAccess(c, publicBookId, "admin");
};

const requireManualBookAdminOrAppAdmin = requireBookAdminOrAppAdmin;

const safeExportFilename = (name: string | null | undefined, extension: "csv" | "vcf"): string => {
  const basename = (name ?? "contacts").replace(/[^a-z0-9-_]+/gi, "_");
  return `${basename}.${extension}`;
};

const loadBookContactsForExport = (bookId: string) => contactsService.contact.list({ bookId, pagination: { page: 1, perPage: 100_000 } });

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

const projectContactPage = async (items: Awaited<ReturnType<typeof contactsService.contact.list>>["items"], favoriteKeys: string[]) => {
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
    const { bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
    if (error) return error;
    const entries = await contactsService.book.access.list({ bookId: internalBookId! });
    return respond(c, ok(entries.items));
  })
  .post("/books/:bookId/access", v("json", GrantAccessSchema), async (c) => {
    const bookId = c.req.param("bookId") ?? "";
    const { principal, permission } = c.req.valid("json");
    const { bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
    if (error) return error;
    return respond(c, contactsService.book.access.grant({ bookId: internalBookId!, principal, permission }));
  })
  .patch("/books/:bookId/access/:accessId", v("json", UpdateAccessSchema), async (c) => {
    const bookId = c.req.param("bookId") ?? "";
    const accessId = c.req.param("accessId") ?? "";
    const { permission } = c.req.valid("json");
    const { bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
    if (error) return error;

    return respondMessage(c, contactsService.book.access.update({ bookId: internalBookId!, accessId, permission }), "Access updated");
  })
  .delete("/books/:bookId/access/:accessId", async (c) => {
    const bookId = c.req.param("bookId") ?? "";
    const accessId = c.req.param("accessId") ?? "";
    const { bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
    if (error) return error;

    return respondMessage(c, contactsService.book.access.remove({ bookId: internalBookId!, accessId }), "Access revoked");
  });

/** Contacts API routes for authenticated users and scoped resource credentials. */
const app = new Hono<AuthContext>()
  .route("/ws", wsRoutes)
  .use(rateLimit())
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
      responses: { 200: jsonResponse(z.array(ContactFavoriteSchema), "Visible personal favorites") },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const [favorites, books] = await Promise.all([
        contactsService.favorite.list(userResult.data.id),
        contactsService.book.list({ subject: { type: "user", userId: userResult.data.id } }),
      ]);
      const readableBookIds = new Set(books.items.map((book) => book.id));
      return respond(c, ok(await projectFavorites(favorites.filter((favorite) => readableBookIds.has(favorite.bookId)))));
    },
  )
  .get(
    "/favorites/:bookId/:contactId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Get personal contact favorite state",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ContactFavoriteStateSchema, "Favorite state"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "read");
      if (error) return error;
      const [internalContactId] = (await resolveBookPublicIds("contacts", internalBookId!, [contactId])) ?? [];
      if (!internalContactId) return respond(c, fail(err.notFound("Contact")));
      return respond(
        c,
        ok({
          favorite: await contactsService.favorite.has({
            userId: userResult.data.id,
            bookId: internalBookId!,
            contactId: internalContactId,
          }),
        }),
      );
    },
  )
  .put(
    "/favorites/:bookId/:contactId",
    documentRoute({
      tags: ["Contacts"],
      summary: "Set personal contact favorite state",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Favorite state updated"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Contact not found"),
      },
    }),
    v("json", SetContactFavoriteSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const { favorite } = c.req.valid("json");
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "read");
      if (error) return error;
      const [internalContactId] = (await resolveBookPublicIds("contacts", internalBookId!, [contactId])) ?? [];
      if (!internalContactId) return respond(c, fail(err.notFound("Contact")));
      if (!favorite) {
        await contactsService.favorite.set({
          userId: userResult.data.id,
          bookId: internalBookId!,
          contactId: internalContactId,
          favorite: false,
        });
        return respondMessage(c, Promise.resolve(ok(undefined)), "Favorite state updated");
      }
      const contact = await contactsService.contact.get({ bookId: internalBookId!, id: internalContactId });
      if (!contact) return respond(c, fail(err.notFound("Contact")));
      await contactsService.favorite.set({
        userId: userResult.data.id,
        bookId: internalBookId!,
        contactId: internalContactId,
        favorite: true,
      });
      return respondMessage(c, Promise.resolve(ok(undefined)), "Favorite state updated");
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
        200: jsonResponse(ContactBookListResponseSchema, "Paginated book list"),
      },
    }),
    v("query", ListBooksQuerySchema),
    async (c) => {
      const subject = getBookAccessSubject(c);
      const binding = await requireReadableCollectionBinding(c, subject);
      if (binding.error) return binding.error;
      const query = c.req.valid("query");
      const pagination = parsePagination(query);

      const result = await contactsService.book.list({
        subject: subject.subject,
        boundBookId: binding.boundBookId,
        pagination,
        filter: { query: query.q },
      });

      return respond(
        c,
        ok({
          data: await projectBooks(result.items),
          pagination: createPagination(pagination, result.total),
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
        200: jsonResponse(ContactBookSchema, "Book details"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Book not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { book, error } = await requireBookAccess(c, bookId, "read");
      if (error || !book) return error!;
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
        200: jsonResponse(ContactBookSettingsContextSchema, "Contact book settings context"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Book not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);

      const bookId = c.req.param("bookId") ?? "";
      const { book, bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
      if (error || !book) return error!;

      const [accessEntries, apiKeys, tags] = await Promise.all([
        contactsService.book.access.list({ bookId: internalBookId! }),
        contactsService.book.access.apiKeys.list({ bookId: internalBookId! }),
        contactsService.tag.list({ bookId: internalBookId! }),
      ]);

      return respond(
        c,
        ok({
          book: (await projectBooks([book]))[0]!,
          accessEntries: accessEntries.items,
          apiKeys,
          tags: await projectTags(tags),
        }),
      );
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
        200: jsonResponse(ContactBookSchema, "Created book"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
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
        200: jsonResponse(ContactBookSchema, "Updated book"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Book not found"),
      },
    }),
    v("json", UpdateBookSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const data = c.req.valid("json");

      const { book, bookId: internalBookId, error } = await requireBookAccess(c, bookId, "admin");
      if (error || !book) return error!;
      const result = await contactsService.book.update({ id: internalBookId!, data });
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
        200: jsonResponse(MessageResponseSchema, "Book deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Book not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";

      const { book, bookId: internalBookId, error } = await requireBookAccess(c, bookId, "admin");
      if (error || !book) return error!;
      return respondMessage(c, contactsService.book.remove({ id: internalBookId! }), "Book deleted");
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
        200: jsonResponse(z.array(AccessEntrySchema), "Access entries"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Book not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";

      const { bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
      if (error) return error;

      const entries = await contactsService.book.access.list({ bookId: internalBookId! });
      return respond(c, ok(entries.items));
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
        200: jsonResponse(AccessEntrySchema, "Created access entry"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
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

      const { bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
      if (error) return error;

      return respond(c, contactsService.book.access.grant({ bookId: internalBookId!, principal, permission }));
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
        200: jsonResponse(MessageResponseSchema, "Access updated"),
        400: jsonResponse(ErrorResponseSchema, "Cannot remove the last admin from this book"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Access entry not found"),
      },
    }),
    v("json", UpdateAccessSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const accessId = c.req.param("accessId") ?? "";
      const { permission } = c.req.valid("json");

      const { bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
      if (error) return error;

      return respondMessage(c, contactsService.book.access.update({ bookId: internalBookId!, accessId, permission }), "Access updated");
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
        200: jsonResponse(MessageResponseSchema, "Access revoked"),
        400: jsonResponse(ErrorResponseSchema, "Cannot remove the last access entry/admin from this book"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Access entry not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";
      const accessId = c.req.param("accessId") ?? "";

      const { bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
      if (error) return error;

      return respondMessage(c, contactsService.book.access.remove({ bookId: internalBookId!, accessId }), "Access revoked");
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
        200: jsonResponse(z.object({ items: z.array(ContactBookApiKeySchema) }), "Contact book API keys"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Book not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const bookId = c.req.param("bookId") ?? "";

      const { bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
      if (error) return error;

      return respond(c, async () => ok({ items: await contactsService.book.access.apiKeys.list({ bookId: internalBookId! }) }));
    },
  )

  .post(
    "/books/:bookId/api-keys",
    documentRoute({
      tags: ["Contacts"],
      summary: "Create contact book API key",
      description: "Create a resource-bound API key for this contact book. The raw token is returned once. Requires admin book access.",
      ...requiresAuth,
      responses: {
        201: jsonResponse(CreateContactBookApiKeyResponseSchema, "Contact book API key created"),
        400: jsonResponse(ErrorResponseSchema, "Failed to create API key"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Book not found"),
      },
    }),
    v("json", CreateContactBookApiKeySchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const bookId = c.req.param("bookId") ?? "";
      const data = c.req.valid("json");

      const { book, bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
      if (error || !book) return error!;

      return respond(
        c,
        contactsService.book.access.apiKeys.create({
          bookId: internalBookId!,
          actor: user,
          bookName: book.name,
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
        200: jsonResponse(MessageResponseSchema, "Contact book API key revoked"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "API key not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const bookId = c.req.param("bookId") ?? "";
      const credentialId = c.req.param("credentialId") ?? "";

      const { bookId: internalBookId, error } = await requireManualBookAdminOrAppAdmin(c, bookId);
      if (error) return error;

      return respond(c, contactsService.book.access.apiKeys.revoke({ bookId: internalBookId!, credentialId, actor: user }));
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
        200: jsonResponse(ContactListResponseSchema, "Paginated contacts"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Book not found"),
      },
    }),
    v("query", ListContactsQuerySchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const query = c.req.valid("query");
      const pagination = parsePagination(query);

      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "read");
      if (error) return error;

      const publicTagIds = Array.isArray(query.tag_id) ? query.tag_id : query.tag_id ? [query.tag_id] : undefined;
      const resolvedTagIds = publicTagIds ? await resolveBookPublicIds("tags", internalBookId!, publicTagIds) : undefined;
      if (publicTagIds && !resolvedTagIds) return respond(c, fail(err.notFound("Tag")));
      const tagIds = resolvedTagIds ?? undefined;
      const user = getUserBackedActor(c);
      if (query.favorites && !user) return respond(c, fail(err.forbidden("Favorites require a user-backed actor")));
      const result = await contactsService.contact.list({
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
      const favoriteKeys = user ? await contactsService.favorite.listKeysForContacts({ userId: user.id, contacts: result.items }) : [];
      const projected = await projectContactPage(result.items, favoriteKeys);

      return respond(
        c,
        ok({
          data: projected.items,
          pagination: createPagination(pagination, result.total),
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
      responses: { 200: jsonResponse(z.array(ContactDuplicateMatchSchema), "Duplicate candidates") },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      return respond(c, ok(await projectDuplicates(await contactsService.contact.duplicates.list({ bookId: internalBookId! }))));
    },
  )

  .post(
    "/books/:bookId/contacts/duplicates/merge",
    documentRoute({
      tags: ["Contacts"],
      summary: "Merge duplicate contacts",
      ...requiresAuth,
      responses: { 200: jsonResponse(ContactSchema, "Merged contact") },
    }),
    v("json", MergeDuplicateSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const data = c.req.valid("json");
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [data.keepId, data.removeId]);
      if (!ids) return respond(c, fail(err.notFound("Contact")));
      const result = await contactsService.contact.duplicates.merge({
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
      responses: { 200: jsonResponse(BulkContactResultSchema, "Updated contact count") },
    }),
    v("json", BulkContactTagsSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { contactIds, tagIds } = c.req.valid("json");
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const [ids, internalTagIds] = await Promise.all([
        resolveBookPublicIds("contacts", internalBookId!, contactIds),
        resolveBookPublicIds("tags", internalBookId!, tagIds),
      ]);
      if (!ids || !internalTagIds) return respond(c, fail(err.notFound("Contact or tag")));
      const result = await contactsService.contact.bulk.addTags({ bookId: internalBookId!, ids, tagIds: internalTagIds });
      return respond(c, result.ok ? ok({ count: result.data }) : result);
    },
  )

  .post(
    "/books/:bookId/contacts/bulk/move",
    documentRoute({
      tags: ["Contacts"],
      summary: "Move contacts to another book",
      ...requiresAuth,
      responses: { 200: jsonResponse(BulkContactResultSchema, "Moved contact count") },
    }),
    v("json", BulkContactMoveSchema),
    async (c) => {
      const sourceBookId = c.req.param("bookId") ?? "";
      const { contactIds, targetBookId } = c.req.valid("json");
      const { bookId: internalSourceBookId, error: sourceError } = await requireBookAccess(c, sourceBookId, "write");
      if (sourceError) return sourceError;
      const { bookId: internalTargetBookId, error: targetError } = await requireBookAccess(c, targetBookId, "write");
      if (targetError) return targetError;
      const ids = await resolveBookPublicIds("contacts", internalSourceBookId!, contactIds);
      if (!ids) return respond(c, fail(err.notFound("Contact")));
      const result = await contactsService.contact.bulk.move({
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
      responses: { 200: jsonResponse(BulkContactResultSchema, "Deleted contact count") },
    }),
    v("json", BulkContactSelectionSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { contactIds } = c.req.valid("json");
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const ids = await resolveBookPublicIds("contacts", internalBookId!, contactIds);
      if (!ids) return respond(c, fail(err.notFound("Contact")));
      const result = await contactsService.contact.bulk.remove({ bookId: internalBookId!, ids });
      return respond(c, result.ok ? ok({ count: result.data }) : result);
    },
  )

  .post(
    "/books/:bookId/contacts/bulk/export.vcf",
    documentRoute({
      tags: ["Contacts"],
      summary: "Export selected contacts as vCard",
      ...requiresAuth,
      responses: { 200: { description: "vCard file" } },
    }),
    v("json", BulkContactSelectionSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { contactIds } = c.req.valid("json");
      const { book, bookId: internalBookId, error } = await requireBookAccess(c, bookId, "read");
      if (error) return error;
      const ids = await resolveBookPublicIds("contacts", internalBookId!, contactIds);
      if (!ids) return respond(c, fail(err.notFound("Contact")));
      const result = await contactsService.contact.getMany({ bookId: internalBookId!, ids });
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
      responses: { 200: { description: "vCard file" } },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "read");
      if (error) return error;
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      const contact = ids ? await contactsService.contact.get({ bookId: internalBookId!, id: ids[0]! }) : null;
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
        200: jsonResponse(ContactSchema, "Contact"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Contact or book not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";

      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "read");
      if (error) return error;
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      const contact = ids ? await contactsService.contact.get({ id: ids[0]!, bookId: internalBookId! }) : null;
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
        200: jsonResponse(ContactTreeSchema, "Contact hierarchy tree"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Contact tree not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";

      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "read");
      if (error) return error;
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      const contactTree = ids ? await contactsService.contact.tree({ id: ids[0]!, bookId: internalBookId! }) : null;
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
        200: jsonResponse(ContactSchema, "Created contact"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Book not found"),
      },
    }),
    v("json", CreateContactSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const data = c.req.valid("json");

      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const internalData = await resolveContactRelations(internalBookId!, data);
      if (!internalData) return respond(c, fail(err.notFound("Parent contact or tag")));
      const result = await contactsService.contact.create({ bookId: internalBookId!, data: internalData });
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
        200: jsonResponse(ContactSchema, "Updated contact"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Contact or book not found"),
      },
    }),
    v("json", UpdateContactSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const data = c.req.valid("json");

      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      const internalData = await resolveContactRelations(internalBookId!, data);
      if (!ids || !internalData) return respond(c, fail(err.notFound("Contact, parent contact, or tag")));
      const result = await contactsService.contact.update({ bookId: internalBookId!, id: ids[0]!, data: internalData });
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
        200: jsonResponse(ContactSchema, "Moved contact"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Contact or book not found"),
      },
    }),
    v("json", MoveContactSchema),
    async (c) => {
      const sourceBookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const { targetBookId } = c.req.valid("json");

      const { bookId: internalSourceBookId, error: sourceError } = await requireBookAccess(c, sourceBookId, "write");
      if (sourceError) return sourceError;

      const { bookId: internalTargetBookId, error: targetError } = await requireBookAccess(c, targetBookId, "write");
      if (targetError) return targetError;
      if (internalSourceBookId === internalTargetBookId) {
        return respond(c, fail(err.badInput("Choose another contact book")));
      }
      const ids = await resolveBookPublicIds("contacts", internalSourceBookId!, [contactId]);
      if (!ids) return respond(c, fail(err.notFound("Contact")));
      const result = await contactsService.contact.move({
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
        200: jsonResponse(MessageResponseSchema, "Contact deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Contact or book not found"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";

      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const ids = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!ids) return respond(c, fail(err.notFound("Contact")));
      return respondMessage(c, contactsService.contact.remove({ bookId: internalBookId!, id: ids[0]! }), "Contact deleted");
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
        200: jsonResponse(ContactNotePageSchema, "Paginated notes timeline"),
      },
    }),
    v("query", PaginationQuerySchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "read");
      if (error) return error;
      const contactIds = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!contactIds) return respond(c, fail(err.notFound("Contact")));
      const page = await contactsService.contact.notes.listPage({
        bookId: internalBookId!,
        contactId: contactIds[0]!,
        viewerUserId: getUserBackedActor(c)?.id ?? null,
        pagination: parsePagination(c.req.valid("query")),
      });
      return respond(c, ok({ ...page, items: await projectNotes(page.items) }));
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
        200: jsonResponse(z.array(ContactNoteSchema), "Notes timeline"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";

      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "read");
      if (error) return error;
      const contactIds = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!contactIds) return respond(c, fail(err.notFound("Contact")));
      const notes = await contactsService.contact.notes.list({
        bookId: internalBookId!,
        contactId: contactIds[0]!,
        viewerUserId: getUserBackedActor(c)?.id ?? null,
      });
      return respond(c, ok(await projectNotes(notes)));
    },
  )
  .post(
    "/books/:bookId/contacts/:contactId/notes",
    documentRoute({
      tags: ["Contacts"],
      summary: "Add a note to a contact",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ContactNoteSchema, "Created note"),
        400: jsonResponse(ErrorResponseSchema, "Validation error"),
      },
    }),
    v("json", ContactNoteInputSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const data = c.req.valid("json");
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;

      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const contactIds = await resolveBookPublicIds("contacts", internalBookId!, [contactId]);
      if (!contactIds) return respond(c, fail(err.notFound("Contact")));
      const result = await contactsService.contact.notes.create({
        bookId: internalBookId!,
        contactId: contactIds[0]!,
        authorUserId: user.id,
        authorDisplayName: user.displayName ?? user.uid,
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
        200: jsonResponse(ContactNoteSchema, "Updated note"),
        403: jsonResponse(ErrorResponseSchema, "Not the author"),
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
      const user = userResult.data;

      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const [contactIds, internalNoteId] = await Promise.all([
        resolveBookPublicIds("contacts", internalBookId!, [contactId]),
        resolvePublicId("notes", noteId),
      ]);
      if (!contactIds || !internalNoteId) return respond(c, fail(err.notFound("Contact note")));
      const result = await contactsService.contact.notes.update({
        bookId: internalBookId!,
        contactId: contactIds[0]!,
        noteId: internalNoteId,
        authorUserId: user.id,
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
        200: jsonResponse(MessageResponseSchema, "Note deleted"),
        403: jsonResponse(ErrorResponseSchema, "Not authorized"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const contactId = c.req.param("contactId") ?? "";
      const noteId = c.req.param("noteId") ?? "";
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;

      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const [contactIds, internalNoteId] = await Promise.all([
        resolveBookPublicIds("contacts", internalBookId!, [contactId]),
        resolvePublicId("notes", noteId),
      ]);
      if (!contactIds || !internalNoteId) return respond(c, fail(err.notFound("Contact note")));

      return respondMessage(
        c,
        contactsService.contact.notes.remove({
          bookId: internalBookId!,
          contactId: contactIds[0]!,
          noteId: internalNoteId,
          authorUserId: user.id,
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
        200: jsonResponse(z.array(ContactTagSchema), "Tags"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "read");
      if (error) return error;
      const items = await contactsService.tag.list({ bookId: internalBookId! });
      return respond(c, ok(await projectTags(items)));
    },
  )
  .post(
    "/books/:bookId/tags",
    documentRoute({
      tags: ["Contacts"],
      summary: "Create a tag",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ContactTagSchema, "Created tag"),
        409: jsonResponse(ErrorResponseSchema, "Name already exists"),
      },
    }),
    v("json", ContactTagCreateInputSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const data = c.req.valid("json");
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const result = await contactsService.tag.create({ bookId: internalBookId!, data });
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
        200: jsonResponse(ContactTagSchema, "Updated tag"),
      },
    }),
    v("json", ContactTagUpdateInputSchema),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const tagId = c.req.param("tagId") ?? "";
      const data = c.req.valid("json");
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const ids = await resolveBookPublicIds("tags", internalBookId!, [tagId]);
      if (!ids) return respond(c, fail(err.notFound("Tag")));
      const result = await contactsService.tag.update({ bookId: internalBookId!, id: ids[0]!, data });
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
        200: jsonResponse(MessageResponseSchema, "Tag deleted"),
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const tagId = c.req.param("tagId") ?? "";
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "write");
      if (error) return error;
      const ids = await resolveBookPublicIds("tags", internalBookId!, [tagId]);
      if (!ids) return respond(c, fail(err.notFound("Tag")));
      return respondMessage(c, contactsService.tag.remove({ bookId: internalBookId!, id: ids[0]! }), "Tag deleted");
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
        200: { description: "vCard file" },
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { book, bookId: internalBookId, error } = await requireBookAccess(c, bookId, "admin");
      if (error) return error;
      const result = await loadBookContactsForExport(internalBookId!);
      const body = vcard.serializeBook(result.items);
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
        200: { description: "CSV file" },
      },
    }),
    async (c) => {
      const bookId = c.req.param("bookId") ?? "";
      const { book, bookId: internalBookId, error } = await requireBookAccess(c, bookId, "admin");
      if (error) return error;
      const result = await loadBookContactsForExport(internalBookId!);
      const body = vcard.serializeBookCsv(result.items);
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
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "admin");
      if (error) return error;
      const body = c.req.valid("json");
      return respond(c, contactsService.import.preview({ bookId: internalBookId!, content: body.content }));
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
      const { bookId: internalBookId, error } = await requireBookAccess(c, bookId, "admin");
      if (error) return error;
      const body = c.req.valid("json");
      return respond(
        c,
        ok(
          await contactsService.import.commit({
            bookId: internalBookId!,
            candidates: body.contacts,
            validateCandidate: (candidate) => {
              const parsed = CreateContactSchema.safeParse(candidate);
              return parsed.success ? ok(parsed.data) : fail(err.badInput(parsed.error.message));
            },
          }),
        ),
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
        200: jsonResponse(ContactListResponseSchema, "Search results"),
      },
    }),
    v("query", SearchContactsQuerySchema),
    async (c) => {
      const subject = getBookAccessSubject(c);
      const binding = await requireReadableCollectionBinding(c, subject);
      if (binding.error) return binding.error;
      const query = c.req.valid("query");
      const pagination = parsePagination(query);
      const user = getUserBackedActor(c);
      const publicTagIds = Array.isArray(query.tag_id) ? query.tag_id : query.tag_id ? [query.tag_id] : undefined;
      const resolvedTagIds = publicTagIds ? await resolvePublicIds("tags", publicTagIds) : undefined;
      if (publicTagIds && !resolvedTagIds) return respond(c, fail(err.notFound("Tag")));
      const tagIds = resolvedTagIds ?? undefined;
      if (query.favorites && !user) return respond(c, fail(err.forbidden("Favorites require a user-backed actor")));
      const result = await contactsService.contact.search({
        subject: subject.subject,
        boundBookId: binding.boundBookId,
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
      const favoriteKeys = user ? await contactsService.favorite.listKeysForContacts({ userId: user.id, contacts: result.items }) : [];
      const projected = await projectContactPage(result.items, favoriteKeys);

      return respond(
        c,
        ok({
          data: projected.items,
          pagination: createPagination(pagination, result.total),
          favoriteKeys: projected.favoriteKeys,
        }),
      );
    },
  );

export default app;
export type ApiType = typeof app;
