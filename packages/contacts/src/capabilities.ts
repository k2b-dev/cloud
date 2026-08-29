import { createHash } from "node:crypto";
import { err, fail, ok, type Paginated, type Result } from "@k2b/stdlib";
import {
  type CapabilityActionReview,
  type CapabilityExecutionContext,
  type CapabilityInvocationResult,
  type CapabilityResult,
  type CloudResourceView,
  capabilityPage,
  defineCapabilities,
  hasRole,
  UniversalSearchDataSchema,
  type UniversalSearchInput,
  UniversalSearchInputSchema,
} from "@valentinkolb/cloud/contracts";
import { hasPermission, type PermissionLevel } from "@valentinkolb/cloud/server";
import { type AuditActor, audit } from "@valentinkolb/cloud/services";
import type { z } from "zod";
import {
  CONTACT_COLLECTION_LIMIT,
  CONTACT_TAG_LIMIT,
  ContactBookDataSchema,
  ContactBookListDataSchema,
  ContactBookListInputSchema,
  ContactBookReadInputSchema,
  ContactCreateInputSchema,
  ContactDeleteDataSchema,
  ContactDeleteInputSchema,
  ContactDetailDataSchema,
  ContactListInputSchema,
  ContactMoveInputSchema,
  ContactMutationDataSchema,
  ContactNoteCreateDataSchema,
  ContactNoteCreateInputSchema,
  ContactNoteDataSchema,
  ContactNoteListDataSchema,
  ContactNoteListInputSchema,
  ContactNoteReadInputSchema,
  ContactReadInputSchema,
  ContactResolveDataSchema,
  ContactResolveInputSchema,
  ContactSuggestDataSchema,
  ContactSuggestInputSchema,
  ContactTagChangeDataSchema,
  ContactTagChangeInputSchema,
  ContactTagDataSchema,
  ContactTagListDataSchema,
  ContactTagListInputSchema,
  ContactTagReadInputSchema,
  ContactUpdateInputSchema,
  FavoriteSetDataSchema,
  FavoriteSetInputSchema,
} from "./capability-contracts";
import { contactCapabilityMessages, type ContactCapabilityMessages } from "./capability-messages";
import { contactsCapabilityPresentation } from "./capability-presentation";
import { type Contact, type ContactBook, type ContactNote, type ContactTag, contactsService } from "./service";
import { CONTACT_BOOK_RESOURCE_TYPE, CONTACTS_APP_ID } from "./service/access";
import {
  projectBooks,
  projectContactReferences,
  projectContacts,
  projectNotes,
  projectTags,
  resolveBookPublicIds,
  resolvePublicId,
  resolvePublicIds,
} from "./service/public-resources";
import { resolveContactName, safeWebsiteHref } from "./shared";

const CONTACT_CREATE_ACTION_ID = "contacts.contact.create";
const NOTE_CREATE_ACTION_ID = "contacts.note.create";

const contactHrefById = (bookId: string, contactId: string): string =>
  `/app/contacts/${encodeURIComponent(bookId)}?contact=${encodeURIComponent(contactId)}&contactBook=${encodeURIComponent(bookId)}`;
const contactHref = (contact: Pick<Contact, "id" | "bookId">): string => contactHrefById(contact.bookId, contact.id);
const bookHref = (bookId: string): string => `/app/contacts/${encodeURIComponent(bookId)}`;
const bookApprovalScope = (bookId: string): string => `book:${bookId}`;
const contactApprovalScope = (contactId: string): string => `contact:${contactId}`;
const FAVORITES_APPROVAL_SCOPE = "favorites";

const contactRef = (contact: Contact) => {
  const preview = contact.emails[0]?.email ?? contact.phones[0]?.phone;
  return {
    type: "contacts.contact" as const,
    id: contact.id,
    title: resolveContactName(contact),
    ...(preview ? { preview } : {}),
    icon: "ti ti-address-book",
  };
};
const bookRef = (book: Pick<ContactBook, "id" | "name" | "description">) => ({
  type: "contacts.book" as const,
  id: book.id,
  title: book.name,
  ...(book.description ? { preview: book.description } : {}),
  icon: "ti ti-book",
});
const tagRef = (tag: Pick<ContactTag, "id" | "name">) => ({
  type: "contacts.tag" as const,
  id: tag.id,
  title: tag.name,
  icon: "ti ti-tag",
});
const noteRef = (note: Pick<ContactNote, "id">, contactName: string) => ({
  type: "contacts.note" as const,
  id: note.id,
  title: `Note on ${contactName}`,
  icon: "ti ti-note",
});

const mapTag = (tag: ContactTag) => ({
  id: tag.id,
  bookId: tag.bookId,
  name: tag.name,
  color: tag.color,
  links: [{ rel: "open" as const, href: `/app/contacts/${tag.bookId}?tag_id=${tag.id}` }],
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
});

const mapContactSummary = (contact: Contact) => ({
  id: contact.id,
  bookId: contact.bookId,
  displayName: resolveContactName(contact),
  companyName: contact.companyName,
  jobTitle: contact.jobTitle,
  primaryEmail: contact.emails[0]?.email ?? null,
  primaryPhone: contact.phones[0]?.phone ?? null,
  tags: contact.tags.slice(0, CONTACT_TAG_LIMIT).map(mapTag),
  updatedAt: contact.updatedAt,
});

const mapContactResourceView = (contact: Contact): CloudResourceView => {
  const primary = contact.emails[0]?.email ?? contact.phones[0]?.phone;
  return {
    ref: { type: "contacts.contact", id: contact.id },
    title: resolveContactName(contact),
    ...(primary ? { preview: primary } : {}),
    icon: "ti ti-address-book",
    priority: 7,
    metadata: [
      { label: "Type", value: "Contact" },
      { label: "Book", value: contact.bookId },
    ],
    links: [{ rel: "open", href: contactHref(contact) }],
  };
};

const mapContactDetail = (contact: Contact) => {
  const websites = contact.websites.flatMap((item) => {
    const url = safeWebsiteHref(item.url);
    return url ? [{ label: item.label, url }] : [];
  });
  const truncatedFields: Array<"tags" | "emails" | "phones" | "addresses" | "websites" | "bankAccounts"> = [];
  if (contact.tags.length > CONTACT_TAG_LIMIT) truncatedFields.push("tags");
  if (contact.emails.length > CONTACT_COLLECTION_LIMIT) truncatedFields.push("emails");
  if (contact.phones.length > CONTACT_COLLECTION_LIMIT) truncatedFields.push("phones");
  if (contact.addresses.length > CONTACT_COLLECTION_LIMIT) truncatedFields.push("addresses");
  if (websites.length > CONTACT_COLLECTION_LIMIT) truncatedFields.push("websites");
  if (contact.bankAccounts.length > CONTACT_COLLECTION_LIMIT) truncatedFields.push("bankAccounts");

  return {
    ...mapContactSummary(contact),
    label: contact.label,
    firstName: contact.firstName,
    lastName: contact.lastName,
    department: contact.department,
    vatId: contact.vatId,
    birthday: contact.birthday,
    salutation: contact.salutation,
    pronouns: contact.pronouns,
    preferredLanguage: contact.preferredLanguage,
    parentContactId: contact.parentContactId,
    emails: contact.emails.slice(0, CONTACT_COLLECTION_LIMIT).map((item) => ({ label: item.label, email: item.email })),
    phones: contact.phones.slice(0, CONTACT_COLLECTION_LIMIT).map((item) => ({ label: item.label, phone: item.phone })),
    addresses: contact.addresses.slice(0, CONTACT_COLLECTION_LIMIT).map((item) => ({
      label: item.label,
      recipientName: item.recipientName,
      companyName: item.companyName,
      line1: item.line1,
      line2: item.line2,
      postalCode: item.postalCode,
      city: item.city,
      stateRegion: item.stateRegion,
      countryCode: item.countryCode,
    })),
    websites: websites.slice(0, CONTACT_COLLECTION_LIMIT),
    bankAccounts: contact.bankAccounts.slice(0, CONTACT_COLLECTION_LIMIT).map((item) => ({
      label: item.label,
      accountHolderName: item.accountHolderName,
      iban: item.iban,
      bic: item.bic,
      bankName: item.bankName,
      note: item.note,
    })),
    truncatedFields,
    createdAt: contact.createdAt,
  };
};

const mapContactSuggestion = (contact: Contact) => ({
  ref: { type: "contacts.contact" as const, id: contact.id },
  contactId: contact.id,
  bookId: contact.bookId,
  displayName: resolveContactName(contact),
  companyName: contact.companyName,
  jobTitle: contact.jobTitle,
  emails: contact.emails.slice(0, 20).map((item) => ({ label: item.label, email: item.email })),
  phones: contact.phones.slice(0, 20).map((item) => ({ label: item.label, phone: item.phone })),
  contactPointsTruncated: contact.emails.length > 20 || contact.phones.length > 20,
  openHref: contactHref(contact),
  links: [{ rel: "open" as const, href: contactHref(contact) }],
  updatedAt: contact.updatedAt,
});

const mapNote = (note: ContactNote) => ({
  id: note.id,
  contactId: note.contactId,
  authorUserId: note.authorUserId,
  authorDisplayName: note.authorDisplayName,
  content: note.content,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
});

const withRef = <Type extends string, Value extends { id: string }>(type: Type, value: Value) => ({
  ...value,
  ref: { type, id: value.id },
});

type ContactUpdateInput = z.infer<typeof ContactUpdateInputSchema>;
type ContactReviewField = Exclude<keyof ContactUpdateInput, "contactId" | "expectedUpdatedAt">;

const contactReviewLabels = (t: ContactCapabilityMessages): Record<ContactReviewField, string> => ({
  label: t.displayLabel,
  firstName: t.firstName,
  lastName: t.lastName,
  companyName: t.organization,
  department: t.department,
  jobTitle: t.jobTitle,
  vatId: t.vatId,
  birthday: t.birthday,
  salutation: t.salutation,
  pronouns: t.pronouns,
  preferredLanguage: t.language,
  parentContactId: t.parentContact,
  tagIds: t.tags,
  emails: t.emailAddresses,
  phones: t.phoneNumbers,
  addresses: t.postalAddresses,
  websites: t.websites,
  bankAccounts: t.bankAccounts,
});

const CONTACT_SUMMARY_LABELS: Record<ContactReviewField, string> = {
  label: "name",
  firstName: "first name",
  lastName: "last name",
  companyName: "organization",
  department: "department",
  jobTitle: "job title",
  vatId: "VAT ID",
  birthday: "birthday",
  salutation: "salutation",
  pronouns: "pronouns",
  preferredLanguage: "language",
  parentContactId: "parent contact",
  tagIds: "tags",
  emails: "email address",
  phones: "phone number",
  addresses: "postal address",
  websites: "website",
  bankAccounts: "bank account",
};

const formatSummaryList = (values: string[]): string => {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
};

const contactUpdateSummary = (before: Contact, after: Contact, fields: ContactReviewField[]): string => {
  const beforeName = resolveContactName(before);
  const afterName = resolveContactName(after);
  const nameFields = new Set<ContactReviewField>(["label", "firstName", "lastName", "companyName"]);
  if (fields.every((field) => nameFields.has(field)) && beforeName !== afterName) return `Renamed ${beforeName} to ${afterName}.`;
  const labels = [...new Set(fields.map((field) => CONTACT_SUMMARY_LABELS[field]))];
  return labels.length === 1 ? `Changed the ${labels[0]} of ${afterName}.` : `Updated the ${formatSummaryList(labels)} of ${afterName}.`;
};

const contactTagSummary = (before: ContactTag[], after: ContactTag[], contactName: string): string => {
  const beforeIds = new Set(before.map((tag) => tag.id));
  const afterIds = new Set(after.map((tag) => tag.id));
  const added = after.filter((tag) => !beforeIds.has(tag.id)).map((tag) => `#${tag.name}`);
  const removed = before.filter((tag) => !afterIds.has(tag.id)).map((tag) => `#${tag.name}`);
  if (added.length > 0 && removed.length > 0) {
    return `Added ${formatSummaryList(added)} and removed ${formatSummaryList(removed)} from ${contactName}.`;
  }
  if (added.length > 0) return `Added ${formatSummaryList(added)} to ${contactName}.`;
  if (removed.length > 0) return `Removed ${formatSummaryList(removed)} from ${contactName}.`;
  return `${contactName} already had the requested tags.`;
};

const boundedReviewText = (value: unknown, none = "None", limit = 240): string => {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return none;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};

const CONTACT_REVIEW_BLOCK_MAX_CHARS = 9_000;
const CONTACT_COLLECTION_FIELDS = new Set<ContactReviewField>(["tagIds", "emails", "phones", "addresses", "websites", "bankAccounts"]);

const contactReviewItem = (
  field: ContactReviewField,
  value: unknown,
  tagNames: ReadonlyMap<string, string>,
  t: ContactCapabilityMessages,
): string => {
  if (field === "tagIds") return tagNames.get(String(value)) ?? String(value);
  if (typeof value !== "object" || value === null) return boundedReviewText(value, t.none);
  const item = value as Record<string, unknown>;
  if (field === "emails") return [item.label, item.email].filter(Boolean).join(" — ");
  if (field === "phones") return [item.label, item.phone].filter(Boolean).join(" — ");
  if (field === "addresses") {
    return [
      item.label,
      item.recipientName,
      item.companyName,
      item.line1,
      item.line2,
      [item.postalCode, item.city].filter(Boolean).join(" "),
      item.stateRegion,
      item.countryCode,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (field === "websites") return [item.label, item.url].filter(Boolean).join(" — ");
  if (field === "bankAccounts") {
    return [
      [item.label, item.accountHolderName, item.iban].filter(Boolean).join(" — "),
      item.bic ? `BIC: ${item.bic}` : null,
      item.bankName ? `${t.bank}: ${item.bankName}` : null,
      item.note ? `${t.bankNote}: ${item.note}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return boundedReviewText(value, t.none);
};

const contactCollectionReviewValue = (
  field: ContactReviewField,
  value: unknown,
  tagNames: ReadonlyMap<string, string>,
  t: ContactCapabilityMessages,
): string => {
  if (!Array.isArray(value) || value.length === 0) return t.none;
  return value.map((item, index) => `${index + 1}. ${contactReviewItem(field, item, tagNames, t)}`).join("\n\n");
};

const contactCollectionReview = (
  field: ContactReviewField,
  current: unknown,
  proposed: unknown,
  tagNames: ReadonlyMap<string, string>,
  t: ContactCapabilityMessages,
): NonNullable<CapabilityActionReview["details"]>[number] => {
  const full = `${t.current}\n${contactCollectionReviewValue(field, current, tagNames, t)}\n\n${t.proposed}\n${contactCollectionReviewValue(
    field,
    proposed,
    tagNames,
    t,
  )}`;
  const truncated = full.length > CONTACT_REVIEW_BLOCK_MAX_CHARS;
  return {
    label: contactReviewLabels(t)[field],
    value: truncated
      ? `${full.slice(0, CONTACT_REVIEW_BLOCK_MAX_CHARS)}\n\n${t.previewTruncated}`
      : full,
    display: "block",
  };
};

const contactReviewValue = (
  field: ContactReviewField,
  value: unknown,
  tagNames: ReadonlyMap<string, string>,
  t: ContactCapabilityMessages,
): string => {
  if (!Array.isArray(value)) return value === null || value === undefined ? t.none : boundedReviewText(value, t.none);
  const preview = value
    .slice(0, 3)
    .map((item) => contactReviewItem(field, item, tagNames, t))
    .join(", ");
  return `${t.itemCount({ count: value.length })}${preview ? `: ${preview}${value.length > 3 ? ", …" : ""}` : ""}`;
};

const currentContactReviewValue = (contact: Contact, field: ContactReviewField): unknown => {
  if (field === "tagIds") return contact.tags.map((tag) => tag.id);
  if (field === "emails") return contact.emails;
  if (field === "phones") return contact.phones;
  if (field === "addresses") return contact.addresses;
  if (field === "websites") return contact.websites;
  if (field === "bankAccounts") return contact.bankAccounts;
  return contact[field];
};

const encodeCursor = (page: number): string => Buffer.from(JSON.stringify({ v: 1, page }), "utf8").toString("base64url");

export const decodeContactCapabilityCursor = (cursor: string | undefined): Result<number> => {
  if (!cursor) return ok(1);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; page?: unknown };
    return value.v === 1 && Number.isSafeInteger(value.page) && Number(value.page) >= 1
      ? ok(Number(value.page))
      : fail(err.badInput("Invalid cursor"));
  } catch {
    return fail(err.badInput("Invalid cursor"));
  }
};

const pageResult = <T>(
  page: Paginated<unknown>,
  data: T,
  refs?: CapabilityResult<T>["refs"],
  links?: CapabilityResult<T>["links"],
): CapabilityInvocationResult<T> =>
  ok({
    data,
    ...(refs ? { refs } : {}),
    ...(links ? { links } : {}),
    page: capabilityPage(page.hasNext ? encodeCursor(page.page + 1) : undefined),
  });

const permissionFromScopes = (scopes: readonly string[]): PermissionLevel => {
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return "none";
};

const minPermission = (left: PermissionLevel, right: PermissionLevel): PermissionLevel => {
  const ranks: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };
  return ranks[left] <= ranks[right] ? left : right;
};

const userBacked = (context: CapabilityExecutionContext) => context.user;

const resourceBoundBookId = (context: CapabilityExecutionContext): string | null => {
  if (context.actor.kind !== "service_account" || context.actor.serviceAccount.kind !== "resource_bound") return null;
  const account = context.actor.serviceAccount;
  return account.appId === CONTACTS_APP_ID && account.resourceType === CONTACT_BOOK_RESOURCE_TYPE ? (account.resourceId ?? null) : null;
};

const serviceAccountBindingValid = (context: CapabilityExecutionContext): boolean =>
  context.accessSubject.type !== "service_account" ||
  (resourceBoundBookId(context) !== null &&
    hasPermission(permissionFromScopes(context.actor.kind === "service_account" ? context.actor.scopes : []), "read"));

const requireBookPermissionInternal = async (
  bookId: string,
  context: CapabilityExecutionContext,
  required: PermissionLevel,
): Promise<Result<{ book: ContactBook; permission: PermissionLevel }>> => {
  const book = await contactsService.book.get({ id: bookId });
  if (!book) return fail(err.notFound("Book"));

  const user = userBacked(context);
  if (user && hasRole(user, "admin")) return ok({ book, permission: "admin" });

  if (context.accessSubject.type === "service_account") {
    const boundBookId = resourceBoundBookId(context);
    if (!boundBookId || boundBookId !== bookId) return fail(err.forbidden("Access denied"));
  }

  let permission = await contactsService.book.permission.get({ bookId, subject: context.accessSubject });
  if (context.actor.kind === "service_account" && context.actor.serviceAccount.kind === "resource_bound") {
    permission = minPermission(permission, permissionFromScopes(context.actor.scopes));
  }
  return hasPermission(permission, required)
    ? ok({ book, permission })
    : fail(err.forbidden(`${required === "read" ? "Read" : "Write"} access to this address book is required`));
};

const requireBookPermission = async (
  publicBookId: string,
  context: CapabilityExecutionContext,
  required: PermissionLevel,
): Promise<Result<{ book: ContactBook; bookId: string; permission: PermissionLevel }>> => {
  const bookId = await resolvePublicId("books", publicBookId);
  if (!bookId) return fail(err.notFound("Book"));
  const access = await requireBookPermissionInternal(bookId, context, required);
  return access.ok ? ok({ ...access.data, bookId }) : access;
};

const resolveContact = async (
  contactId: string,
  context: CapabilityExecutionContext,
  required: PermissionLevel = "read",
): Promise<Result<{ contact: Contact; bookId: string; contactId: string }>> => {
  const internalContactId = await resolvePublicId("contacts", contactId);
  if (!internalContactId) return fail(err.notFound("Contact"));
  const bookId = await contactsService.contact.findBookId({ id: internalContactId });
  if (!bookId) return fail(err.notFound("Contact"));
  const access = await requireBookPermissionInternal(bookId, context, required);
  if (!access.ok) return access;
  const contact = await contactsService.contact.get({ bookId, id: internalContactId });
  return contact ? ok({ contact, bookId, contactId: internalContactId }) : fail(err.notFound("Contact"));
};

const capabilityAuditActor = (context: CapabilityExecutionContext): AuditActor =>
  context.actor.kind === "user"
    ? {
        userId: context.actor.user.id,
        uid: context.actor.user.uid,
        provider: context.actor.user.provider,
        roles: context.actor.user.roles,
      }
    : {
        uid: `service-account:${context.actor.serviceAccount.id}`,
        provider: "service_account",
        roles: context.actor.scopes,
      };

const actionAudit = (context: CapabilityExecutionContext, actionId: string, targetType: string, targetId: string) => ({
  action: `contacts.capability.${actionId}`,
  actor: capabilityAuditActor(context),
  target: { type: targetType, id: targetId },
  metadata: { capability: `contacts.${actionId}` },
});

const audited = async <T>(
  params: ReturnType<typeof actionAudit>,
  operation: () => Promise<CapabilityInvocationResult<T>>,
  replayed: boolean | (() => boolean) = false,
): Promise<CapabilityInvocationResult<T>> => {
  const result = await operation();
  if (!result.ok) return audit.recordResult({ ...params, result });
  const wasReplayed = typeof replayed === "function" ? replayed() : replayed;
  return wasReplayed
    ? audit.recordResult({ ...params, metadata: { ...params.metadata, replayed: true }, result })
    : audit.recordResultAfterSideEffect({ ...params, result });
};

const actorKey = (context: CapabilityExecutionContext): string =>
  context.accessSubject.type === "user"
    ? `user:${context.accessSubject.userId}:${context.accessSubject.delegatedByServiceAccountId ?? "direct"}`
    : `service_account:${context.accessSubject.serviceAccountId}`;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const boundedCapabilitySummary = (value: string): string => {
  let summary = "";
  for (const character of value.trim()) {
    if (`${summary}${character}`.length > 500) break;
    summary += character;
  }
  return summary;
};

const runSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const user = userBacked(context);
  if ((!user || (!user.roles.includes("user") && !user.roles.includes("admin"))) && !serviceAccountBindingValid(context)) {
    return ok({ data: [] });
  }
  const tags = new Set(input.tags);
  const page = await contactsService.contact.search({
    subject: context.accessSubject,
    boundBookId: resourceBoundBookId(context),
    bypassAccess: Boolean(user && hasRole(user, "admin")),
    pagination: { page: 1, perPage: input.limit },
    filter: {
      query: input.query,
      email: tags.has("email") ? "yes" : "all",
      phone: tags.has("phone") ? "yes" : "all",
    },
  });
  const contacts = await projectContacts(page.items);
  const data = contacts.map(mapContactResourceView);
  return ok({ data });
};

const runContactSuggest = async (input: z.infer<typeof ContactSuggestInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeContactCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  if (!serviceAccountBindingValid(context)) return fail(err.forbidden("A readable Contacts credential is required"));
  const user = userBacked(context);
  const page = await contactsService.contact.search({
    subject: context.accessSubject,
    boundBookId: resourceBoundBookId(context),
    bypassAccess: Boolean(user && hasRole(user, "admin")),
    pagination: { page: cursor.data, perPage: input.limit },
    filter: {
      query: input.query,
      email: "yes",
    },
  });
  const contacts = await projectContacts(page.items);
  return pageResult(page, contacts.map(mapContactSuggestion), contacts.map(contactRef));
};

const runContactResolve = async (input: z.infer<typeof ContactResolveInputSchema>, context: CapabilityExecutionContext) => {
  if (!serviceAccountBindingValid(context)) return fail(err.forbidden("A readable Contacts credential is required"));
  const internalContactIds = input.contactIds ? await resolvePublicIds("contacts", input.contactIds) : undefined;
  if (input.contactIds && !internalContactIds) return fail(err.notFound("Contact"));
  const normalizedInput = {
    ...input,
    emails: [...new Set(input.emails.map((email) => email.trim().toLowerCase()))],
    ...(internalContactIds ? { contactIds: [...new Set(internalContactIds)] } : {}),
  };
  const result = await contactsService.lookup.resolveContactsByEmail({
    subject: context.accessSubject,
    boundBookId: resourceBoundBookId(context),
    input: normalizedInput,
  });
  if (!result.ok) return result;
  const { nextCursor, ...resolvedData } = result.data;
  const publicItems = await projectContactReferences(resolvedData.items);
  const data = {
    ...resolvedData,
    items: publicItems.map((contact) => ({
      ...contact,
      ref: { type: "contacts.contact" as const, id: contact.contactId },
      openHref: contactHrefById(contact.bookId, contact.contactId),
      links: [{ rel: "open" as const, href: contactHrefById(contact.bookId, contact.contactId) }],
    })),
  };
  return ok({
    data,
    refs: data.items.map((contact) => ({
      type: "contacts.contact",
      id: contact.contactId,
      title: contact.displayName,
      preview: contact.bookName,
      icon: "ti ti-address-book",
    })),
    page: capabilityPage(nextCursor),
  });
};

const runContactList = async (input: z.infer<typeof ContactListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeContactCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const access = await requireBookPermission(input.bookId, context, "read");
  if (!access.ok) return access;
  if (input.favoritesOnly && !userBacked(context)) return fail(err.forbidden("Favorites require a user-backed actor"));
  const tagIds = input.tagIds ? await resolveBookPublicIds("tags", access.data.bookId, input.tagIds) : undefined;
  if (input.tagIds && !tagIds) return fail(err.notFound("Tag"));
  const page = await contactsService.contact.list({
    bookId: access.data.bookId,
    pagination: { page: cursor.data, perPage: input.limit },
    filter: {
      query: input.query,
      tagIds: tagIds ?? undefined,
      sort: input.sort,
      email: input.email,
      phone: input.phone,
      ...(input.favoritesOnly && userBacked(context) ? { favoriteUserId: userBacked(context)?.id } : {}),
    },
  });
  const contacts = await projectContacts(page.items);
  return pageResult(page, contacts.map(mapContactResourceView));
};

const runContactRead = async (input: z.infer<typeof ContactReadInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await resolveContact(input.id, context);
  if (!resolved.ok) return resolved;
  const [contact] = await projectContacts([resolved.data.contact]);
  if (!contact) return fail(err.notFound("Contact"));
  return ok({
    data: mapContactDetail(contact),
    summary: boundedCapabilitySummary(`Read contact “${resolveContactName(contact)}”.`),
    refs: [contactRef(contact)],
    links: [{ rel: "open" as const, href: contactHref(contact) }],
  });
};

const runBookRead = async (input: z.infer<typeof ContactBookReadInputSchema>, context: CapabilityExecutionContext) => {
  const access = await requireBookPermission(input.id, context, "read");
  if (!access.ok) return access;
  const [book] = await projectBooks([access.data.book]);
  if (!book) return fail(err.notFound("Book"));
  return ok({
    data: {
      id: book.id,
      name: book.name,
      description: book.description,
      permission: access.data.permission,
      links: [{ rel: "open" as const, href: `/app/contacts/${book.id}` }],
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
    },
    summary: boundedCapabilitySummary(`Read address book “${book.name}”.`),
    refs: [bookRef(book)],
    links: [{ rel: "open" as const, href: `/app/contacts/${book.id}` }],
  });
};

const runTagRead = async (input: z.infer<typeof ContactTagReadInputSchema>, context: CapabilityExecutionContext) => {
  const tagId = await resolvePublicId("tags", input.id);
  if (!tagId) return fail(err.notFound("Tag"));
  const tag = await contactsService.tag.get({ id: tagId });
  if (!tag) return fail(err.notFound("Tag"));
  const access = await requireBookPermissionInternal(tag.bookId, context, "read");
  if (!access.ok) return access;
  const [publicTag] = await projectTags([tag]);
  if (!publicTag) return fail(err.notFound("Tag"));
  const data = mapTag(publicTag);
  return ok({
    data,
    summary: boundedCapabilitySummary(`Read contact tag “${publicTag.name}”.`),
    refs: [tagRef(publicTag)],
    links: data.links,
  });
};

const runNoteRead = async (input: z.infer<typeof ContactNoteReadInputSchema>, context: CapabilityExecutionContext) => {
  const noteId = await resolvePublicId("notes", input.id);
  if (!noteId) return fail(err.notFound("Note"));
  const note = await contactsService.contact.notes.get({ id: noteId });
  if (!note) return fail(err.notFound("Note"));
  const bookId = await contactsService.contact.findBookId({ id: note.contactId });
  if (!bookId) return fail(err.notFound("Contact"));
  const access = await requireBookPermissionInternal(bookId, context, "read");
  if (!access.ok) return access;
  const contact = await contactsService.contact.get({ bookId, id: note.contactId });
  if (!contact) return fail(err.notFound("Contact"));
  const [publicNote] = await projectNotes([note]);
  const [publicContact] = await projectContacts([contact]);
  if (!publicNote || !publicContact) return fail(err.notFound("Note"));
  return ok({
    data: mapNote(publicNote),
    summary: boundedCapabilitySummary(`Read a contact note on “${resolveContactName(publicContact)}”.`),
    refs: [noteRef(publicNote, resolveContactName(publicContact)), contactRef(publicContact)],
    links: [{ rel: "open" as const, href: contactHref(publicContact) }],
  });
};

const runBookList = async (input: z.infer<typeof ContactBookListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeContactCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  if (!serviceAccountBindingValid(context)) return fail(err.forbidden("A resource-bound Contacts credential is required"));
  const scopedPermission =
    context.actor.kind === "service_account" && context.actor.serviceAccount.kind === "resource_bound"
      ? permissionFromScopes(context.actor.scopes)
      : ("admin" as PermissionLevel);
  if (!hasPermission(scopedPermission, input.minimumPermission)) {
    return fail(err.forbidden(`The Contacts credential does not grant ${input.minimumPermission} access`));
  }
  const user = userBacked(context);
  if (user && hasRole(user, "admin")) {
    const page = await contactsService.book.admin.list({
      pagination: { page: cursor.data, perPage: input.limit },
      filter: { query: input.query },
    });
    const books = await projectBooks(page.items);
    return pageResult(
      page,
      books.map((book) => ({
        ref: { type: "contacts.book" as const, id: book.id },
        id: book.id,
        name: book.name,
        description: book.description,
        permission: "admin" as const,
        links: [{ rel: "open" as const, href: `/app/contacts/${book.id}` }],
        createdAt: book.createdAt,
        updatedAt: book.updatedAt,
      })),
      books.map(bookRef),
    );
  }
  const page = await contactsService.book.listPage({
    subject: context.accessSubject,
    boundBookId: resourceBoundBookId(context),
    pagination: { page: cursor.data, perPage: input.limit },
    filter: { query: input.query, minimumPermission: input.minimumPermission },
  });
  const books = await projectBooks(page.items);
  return pageResult(
    page,
    books.map((book) => ({
      ref: { type: "contacts.book" as const, id: book.id },
      id: book.id,
      name: book.name,
      description: book.description,
      permission: minPermission(book.permission, scopedPermission) as "read" | "write" | "admin",
      links: [{ rel: "open" as const, href: `/app/contacts/${book.id}` }],
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
    })),
    books.map(bookRef),
  );
};

const runTagList = async (input: z.infer<typeof ContactTagListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeContactCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const access = await requireBookPermission(input.bookId, context, "read");
  if (!access.ok) return access;
  const page = await contactsService.tag.listPage({ bookId: access.data.bookId, pagination: { page: cursor.data, perPage: input.limit } });
  const tags = await projectTags(page.items);
  return pageResult(
    page,
    tags.map((tag) => withRef("contacts.tag", mapTag(tag))),
    tags.map(tagRef),
  );
};

const runNoteList = async (input: z.infer<typeof ContactNoteListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeContactCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const resolved = await resolveContact(input.contactId, context);
  if (!resolved.ok) return resolved;
  const page = await contactsService.contact.notes.listPage({
    bookId: resolved.data.bookId,
    contactId: resolved.data.contactId,
    pagination: { page: cursor.data, perPage: input.limit },
  });
  const notes = await projectNotes(page.items);
  const [contact] = await projectContacts([resolved.data.contact]);
  if (!contact) return fail(err.notFound("Contact"));
  return pageResult(
    page,
    notes.map((note) => withRef("contacts.note", mapNote(note))),
    notes.map((note) => noteRef(note, resolveContactName(contact))),
    [{ rel: "open" as const, href: contactHref(contact) }],
  );
};

const reviewContactAction = async (
  contactId: string,
  context: CapabilityExecutionContext,
  required: PermissionLevel,
  describe: (
    contact: Contact,
    internalContact: Contact,
  ) => Omit<CapabilityActionReview, "links"> | Promise<Omit<CapabilityActionReview, "links">>,
) => {
  const resolved = await resolveContact(contactId, context, required);
  if (!resolved.ok) return resolved;
  const [contact] = await projectContacts([resolved.data.contact]);
  if (!contact) return fail(err.notFound("Contact"));
  return ok({ ...(await describe(contact, resolved.data.contact)), links: [{ rel: "open" as const, href: contactHref(contact) }] });
};

const resolveWriteRelations = async <T extends { parentContactId?: string | null; tagIds?: string[] }>(bookId: string, data: T) => {
  const parentIds = data.parentContactId ? await resolveBookPublicIds("contacts", bookId, [data.parentContactId]) : [];
  if (data.parentContactId && !parentIds) return fail(err.notFound("Parent contact"));
  const tagIds = data.tagIds ? await resolveBookPublicIds("tags", bookId, data.tagIds) : undefined;
  if (data.tagIds && !tagIds) return fail(err.notFound("Tag"));
  return ok({
    ...data,
    ...(data.parentContactId !== undefined ? { parentContactId: data.parentContactId === null ? null : parentIds?.[0] } : {}),
    ...(data.tagIds !== undefined ? { tagIds } : {}),
  });
};

const runContactCreate = async (input: z.infer<typeof ContactCreateInputSchema>, context: CapabilityExecutionContext) => {
  const auditParams = actionAudit(context, "contact.create", "contact_book", input.bookId);
  let replayed = false;
  return audited(
    auditParams,
    async () => {
      if (!context.idempotencyKey) return fail(err.badInput("Idempotency-Key is required"));
      const access = await requireBookPermission(input.bookId, context, "write");
      if (!access.ok) return access;
      const { bookId, ...data } = input;
      const internalData = await resolveWriteRelations(access.data.bookId, data);
      if (!internalData.ok) return internalData;
      const result = await contactsService.contact.createIdempotent({
        bookId: access.data.bookId,
        data: { ...internalData.data, source: "capability" },
        actorKey: actorKey(context),
        actionId: CONTACT_CREATE_ACTION_ID,
        idempotencyKeyHash: sha256(context.idempotencyKey),
        requestHash: sha256(JSON.stringify(input)),
      });
      if (!result.ok) return result;
      replayed = result.data.replayed;
      const contact = await contactsService.contact.get({ bookId: access.data.bookId, id: result.data.id });
      const [publicContact] = contact ? await projectContacts([contact]) : [];
      return publicContact
        ? ok({
            data: { contact: mapContactDetail(publicContact) },
            summary: boundedCapabilitySummary(`Created ${resolveContactName(publicContact)} in ${access.data.book.name}.`),
            refs: [bookRef(access.data.book), contactRef(publicContact)],
            links: [{ rel: "edit", href: contactHref(publicContact) }],
          })
        : fail(err.conflict("The contact created by this idempotency key no longer exists"));
    },
    () => replayed,
  );
};

const runContactUpdate = async (input: z.infer<typeof ContactUpdateInputSchema>, context: CapabilityExecutionContext) => {
  const auditParams = actionAudit(context, "contact.update", "contact", input.contactId);
  return audited(auditParams, async () => {
    const resolved = await resolveContact(input.contactId, context, "write");
    if (!resolved.ok) return resolved;
    const { contactId, expectedUpdatedAt, ...data } = input;
    const internalData = await resolveWriteRelations(resolved.data.bookId, data);
    if (!internalData.ok) return internalData;
    const result = await contactsService.contact.update({
      bookId: resolved.data.bookId,
      id: resolved.data.contactId,
      expectedUpdatedAt,
      data: internalData.data,
    });
    const [contact] = result.ok ? await projectContacts([result.data]) : [];
    return result.ok
      ? ok({
          data: { contact: mapContactDetail(contact!) },
          summary: boundedCapabilitySummary(
            contactUpdateSummary(resolved.data.contact, result.data, Object.keys(data) as ContactReviewField[]),
          ),
          refs: [contactRef(contact!)],
          links: [{ rel: "edit", href: contactHref(contact!) }],
        })
      : result;
  });
};

const runContactMove = async (input: z.infer<typeof ContactMoveInputSchema>, context: CapabilityExecutionContext) => {
  const auditParams = actionAudit(context, "contact.move", "contact", input.contactId);
  return audited(auditParams, async () => {
    const source = await resolveContact(input.contactId, context, "write");
    if (!source.ok) return source;
    const target = await requireBookPermission(input.targetBookId, context, "write");
    if (!target.ok) return target;
    const result = await contactsService.contact.move({
      sourceBookId: source.data.bookId,
      targetBookId: target.data.bookId,
      id: source.data.contactId,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    const [contact] = result.ok ? await projectContacts([result.data]) : [];
    return result.ok
      ? ok({
          data: { contact: mapContactDetail(contact!) },
          summary: boundedCapabilitySummary(`Moved ${resolveContactName(contact!)} to ${target.data.book.name}.`),
          refs: [contactRef(contact!)],
          links: [{ rel: "edit", href: contactHref(contact!) }],
        })
      : result;
  });
};

const runContactDelete = async (input: z.infer<typeof ContactDeleteInputSchema>, context: CapabilityExecutionContext) => {
  const auditParams = actionAudit(context, "contact.delete", "contact", input.contactId);
  return audited(auditParams, async () => {
    const resolved = await resolveContact(input.contactId, context, "write");
    if (!resolved.ok) return resolved;
    const result = await contactsService.contact.remove({
      bookId: resolved.data.bookId,
      id: resolved.data.contactId,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    return result.ok
      ? ok({
          data: { contactId: input.contactId, deleted: true as const },
          summary: boundedCapabilitySummary(`Deleted ${resolveContactName(resolved.data.contact)}.`),
        })
      : result;
  });
};

const runFavoriteSet = async (input: z.infer<typeof FavoriteSetInputSchema>, context: CapabilityExecutionContext) => {
  const auditParams = actionAudit(context, "favorite.set", "contact", input.contactId);
  return audited(auditParams, async () => {
    const user = userBacked(context);
    if (!user) return fail(err.forbidden("Favorites require a user-backed actor"));
    const resolved = await resolveContact(input.contactId, context);
    if (!resolved.ok) return resolved;
    await contactsService.favorite.set({
      userId: user.id,
      bookId: resolved.data.bookId,
      contactId: resolved.data.contactId,
      favorite: input.favorite,
    });
    return ok({
      data: { contactId: input.contactId, favorite: input.favorite },
      summary: boundedCapabilitySummary(
        `${resolveContactName(resolved.data.contact)} ${input.favorite ? "is in favorites" : "is no longer in favorites"}.`,
      ),
      refs: [contactRef(resolved.data.contact)],
      links: [{ rel: "open" as const, href: contactHref((await projectContacts([resolved.data.contact]))[0]!) }],
    });
  });
};

const runTagChange = async (input: z.infer<typeof ContactTagChangeInputSchema>, context: CapabilityExecutionContext) => {
  const auditParams = actionAudit(context, "tag.change", "contact", input.contactId);
  return audited(auditParams, async () => {
    const resolved = await resolveContact(input.contactId, context, "write");
    if (!resolved.ok) return resolved;
    const addTagIds = await resolveBookPublicIds("tags", resolved.data.bookId, input.addTagIds);
    const removeTagIds = await resolveBookPublicIds("tags", resolved.data.bookId, input.removeTagIds);
    if (!addTagIds || !removeTagIds) return fail(err.notFound("Tag"));
    const result = await contactsService.tag.changeAssignments({
      bookId: resolved.data.bookId,
      contactId: resolved.data.contactId,
      addTagIds,
      removeTagIds,
    });
    const tags = result.ok ? await projectTags(result.data) : [];
    const [contact] = await projectContacts([resolved.data.contact]);
    return result.ok
      ? ok({
          data: {
            contactId: input.contactId,
            tags: tags.slice(0, CONTACT_TAG_LIMIT).map(mapTag),
            tagsTruncated: result.data.length > CONTACT_TAG_LIMIT,
          },
          summary: boundedCapabilitySummary(
            contactTagSummary(resolved.data.contact.tags, result.data, resolveContactName(resolved.data.contact)),
          ),
          refs: [contactRef(resolved.data.contact)],
          links: [{ rel: "open" as const, href: contactHref(contact!) }],
        })
      : result;
  });
};

const runNoteCreate = async (input: z.infer<typeof ContactNoteCreateInputSchema>, context: CapabilityExecutionContext) => {
  const auditParams = actionAudit(context, "note.create", "contact", input.contactId);
  let replayed = false;
  const result = await audited(
    auditParams,
    async () => {
      const user = userBacked(context);
      if (!user) return fail(err.forbidden("Notes require a user-backed actor"));
      if (!context.idempotencyKey) return fail(err.badInput("Idempotency-Key is required"));
      const resolved = await resolveContact(input.contactId, context, "write");
      if (!resolved.ok) return resolved;
      const created = await contactsService.contact.notes.createIdempotent({
        bookId: resolved.data.bookId,
        contactId: resolved.data.contactId,
        authorUserId: user.id,
        authorDisplayName: user.displayName,
        data: { content: input.content },
        actorKey: actorKey(context),
        actionId: NOTE_CREATE_ACTION_ID,
        idempotencyKeyHash: sha256(context.idempotencyKey),
        requestHash: sha256(JSON.stringify(input)),
      });
      if (!created.ok) return created;
      replayed = created.data.replayed;
      const [note] = await projectNotes([created.data.note]);
      const [contact] = await projectContacts([resolved.data.contact]);
      return ok({
        data: { note: mapNote(note!) },
        summary: boundedCapabilitySummary(`Added a note to ${resolveContactName(resolved.data.contact)}.`),
        refs: [noteRef(note!, resolveContactName(resolved.data.contact)), contactRef(resolved.data.contact)],
        links: [{ rel: "open" as const, href: contactHref(contact!) }],
      });
    },
    () => replayed,
  );
  return result;
};

export const contactsCapabilities = defineCapabilities({
  protocolVersion: 1,
  presentation: contactsCapabilityPresentation,
  types: {
    contact: {
      title: "Contact",
      description: "A person or organization in an address book.",
      icon: "ti ti-address-book",
      reader: "contact.read",
    },
    book: { title: "Address book", description: "A permission-scoped collection of contacts.", icon: "ti ti-book", reader: "book.read" },
    tag: { title: "Contact tag", description: "A book-scoped label assigned to contacts.", icon: "ti ti-tag", reader: "tag.read" },
    note: {
      title: "Contact note",
      description: "A user-authored note attached to a contact.",
      icon: "ti ti-note",
      reader: "note.read",
    },
  },
  queries: {
    "contact.search": {
      title: "Search contacts",
      description:
        "Normal cross-book discovery entry when no address book is known. Find contacts by name, email, phone, or book facet and use returned contacts.contact refs with contact.read.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [
          { tag: "contact", title: "Contacts", description: "Show contact cards.", aliases: ["addressbook"] },
          { tag: "phone", title: "Phone", description: "Show contacts that have a phone number." },
          { tag: "email", title: "Email", description: "Show contacts that have an email address." },
        ],
      },
      run: runSearch,
    },
    "contact.suggest": {
      title: "Suggest contacts",
      description:
        "Specialized recipient picker for composing mail. Returns email-capable contacts and contacts.contact refs; use contact.search for general discovery or contact.resolve when exact email addresses are already known.",
      input: ContactSuggestInputSchema,
      data: ContactSuggestDataSchema,
      openWorld: false,
      run: runContactSuggest,
    },
    "contact.resolve": {
      title: "Resolve contacts by email",
      description:
        "Specialized lookup for known exact email addresses or contact IDs. Returns canonical contacts.contact refs; use contact.search when the contact is not known and contact.suggest for recipient suggestions.",
      input: ContactResolveInputSchema,
      data: ContactResolveDataSchema,
      openWorld: false,
      run: runContactResolve,
    },
    "contact.list": {
      title: "List contacts",
      description:
        "Browse and filter contacts inside one known address book. Get bookId from book.list; use returned contacts.contact refs with contact.read. Use contact.search instead when no book is known.",
      input: ContactListInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      run: runContactList,
    },
    "contact.read": {
      title: "Read contact",
      description:
        "Read one contacts.contact ref returned by contact.search, contact.list, contact.suggest, or contact.resolve after checking its owning address book.",
      input: ContactReadInputSchema,
      data: ContactDetailDataSchema,
      openWorld: false,
      run: runContactRead,
    },
    "book.read": {
      title: "Read address book",
      description: "Read one contacts.book ref or address-book ID returned by book.list.",
      input: ContactBookReadInputSchema,
      data: ContactBookDataSchema,
      openWorld: false,
      run: runBookRead,
    },
    "tag.read": {
      title: "Read contact tag",
      description: "Read one contacts.tag ref returned by tag.list after checking its owning address book.",
      input: ContactTagReadInputSchema,
      data: ContactTagDataSchema,
      openWorld: false,
      run: runTagRead,
    },
    "note.read": {
      title: "Read contact note",
      description: "Read one contacts.note ref returned by note.list after checking its parent contact and address book.",
      input: ContactNoteReadInputSchema,
      data: ContactNoteDataSchema,
      openWorld: false,
      run: runNoteRead,
    },
    "book.list": {
      title: "List address books",
      description:
        "Normal entry for book-scoped Contacts work. List readable address books with effective permissions; use returned contacts.book refs or IDs with contact.list, tag.list, or contact.create.",
      input: ContactBookListInputSchema,
      data: ContactBookListDataSchema,
      openWorld: false,
      run: runBookList,
    },
    "tag.list": {
      title: "List contact tags",
      description:
        "List tags in one known address book. Get bookId from book.list; use returned contacts.tag refs with tag.read or their IDs with contact.list and tag.change.",
      input: ContactTagListInputSchema,
      data: ContactTagListDataSchema,
      openWorld: false,
      run: runTagList,
    },
    "note.list": {
      title: "List contact notes",
      description:
        "List notes for one known contact, newest first. Get contactId from a contacts.contact ref; use returned contacts.note refs with note.read.",
      input: ContactNoteListInputSchema,
      data: ContactNoteListDataSchema,
      openWorld: false,
      run: runNoteList,
    },
  },
  actions: {
    "contact.create": {
      title: "Create contact",
      description: "Create one contact in an explicitly selected writable address book.",
      input: ContactCreateInputSchema,
      data: ContactMutationDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      approval: "rememberable",
      review: async (input, context) => {
        const { t } = contactCapabilityMessages.resolve([context.locale]);
        const access = await requireBookPermission(input.bookId, context, "write");
        if (!access.ok) return access;
        const { bookId: _bookId, ...data } = input;
        const internalData = await resolveWriteRelations(access.data.bookId, data);
        if (!internalData.ok) return internalData;
        const [publicBook] = await projectBooks([access.data.book]);
        if (!publicBook) return fail(err.notFound("Book"));
        const fields = Object.keys(data) as ContactReviewField[];
        const tagNames = new Map<string, string>();
        if (fields.includes("tagIds")) {
          const tags = await projectTags(await contactsService.tag.list({ bookId: access.data.bookId }));
          for (const tag of tags) tagNames.set(tag.id, tag.name);
        }
        return ok({
          message: t.createReview({ book: publicBook.name }),
          details: [
            { label: t.addressBook, value: publicBook.name },
            ...fields.map((field): NonNullable<CapabilityActionReview["details"]>[number] => {
              const value = data[field];
              if (field === "birthday" && typeof value === "string") {
                return { label: contactReviewLabels(t)[field], value, format: "date" };
              }
              if (CONTACT_COLLECTION_FIELDS.has(field)) {
                const full = contactCollectionReviewValue(field, value, tagNames, t);
                return {
                  label: contactReviewLabels(t)[field],
                  value:
                    full.length > CONTACT_REVIEW_BLOCK_MAX_CHARS
                      ? `${full.slice(0, CONTACT_REVIEW_BLOCK_MAX_CHARS)}\n\n${t.previewTruncated}`
                      : full,
                  display: "block",
                };
              }
              return { label: contactReviewLabels(t)[field], value: contactReviewValue(field, value, tagNames, t) };
            }),
          ],
          links: [{ rel: "open" as const, href: bookHref(publicBook.id) }],
          approvalScope: bookApprovalScope(publicBook.id),
        });
      },
      run: runContactCreate,
    },
    "contact.update": {
      title: "Update contact",
      description: "Update selected contact fields; provided collection fields replace their current values.",
      input: ContactUpdateInputSchema,
      data: ContactMutationDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: (input, context) => {
        const { t } = contactCapabilityMessages.resolve([context.locale]);
        return reviewContactAction(input.contactId, context, "write", async (contact, internalContact) => {
          const changedFields = Object.keys(input).filter(
            (field): field is ContactReviewField => field !== "contactId" && field !== "expectedUpdatedAt",
          );
          const tagNames = new Map<string, string>();
          if (changedFields.includes("tagIds")) {
            const tags = await projectTags(await contactsService.tag.list({ bookId: internalContact.bookId }));
            for (const tag of tags) tagNames.set(tag.id, tag.name);
          }
          return {
            message: t.updateReview({ contact: resolveContactName(contact) }),
            details: [
              { label: t.contact, value: resolveContactName(contact) },
              ...changedFields.flatMap((field): NonNullable<CapabilityActionReview["details"]> => {
                const current = currentContactReviewValue(contact, field);
                const proposed = input[field];
                if (CONTACT_COLLECTION_FIELDS.has(field)) {
                  return [contactCollectionReview(field, current, proposed, tagNames, t)];
                }
                if (field === "birthday") {
                  return [
                    {
                      label: t.currentBirthday,
                      value: typeof current === "string" ? current : t.none,
                      ...(typeof current === "string" ? { format: "date" as const } : {}),
                    },
                    {
                      label: t.newBirthday,
                      value: typeof proposed === "string" ? proposed : t.none,
                      ...(typeof proposed === "string" ? { format: "date" as const } : {}),
                    },
                  ];
                }
                return [
                  {
                    label: contactReviewLabels(t)[field],
                    value: `${contactReviewValue(field, current, tagNames, t)} → ${contactReviewValue(field, proposed, tagNames, t)}`,
                  },
                ];
              }),
            ],
            approvalScope: bookApprovalScope(contact.bookId),
          };
        });
      },
      run: runContactUpdate,
    },
    "contact.move": {
      title: "Move contact",
      description: "Move a contact to another writable book. Book-scoped tags and hierarchy links are removed.",
      input: ContactMoveInputSchema,
      data: ContactMutationDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      review: async (input, context) => {
        const { t } = contactCapabilityMessages.resolve([context.locale]);
        const target = await requireBookPermission(input.targetBookId, context, "write");
        if (!target.ok) return target;
        return reviewContactAction(input.contactId, context, "write", (contact) => ({
          message: t.moveReview({ contact: resolveContactName(contact), book: target.data.book.name }),
          details: [
            { label: t.contact, value: resolveContactName(contact) },
            { label: t.destination, value: target.data.book.name },
            { label: t.consequence, value: t.moveConsequence },
          ],
        }));
      },
      run: runContactMove,
    },
    "contact.delete": {
      title: "Delete contact",
      description: "Permanently delete one contact after an optimistic version check.",
      input: ContactDeleteInputSchema,
      data: ContactDeleteDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      review: (input, context) => {
        const { t } = contactCapabilityMessages.resolve([context.locale]);
        return reviewContactAction(input.contactId, context, "write", (contact) => ({
          message: t.deleteReview({ contact: resolveContactName(contact) }),
          details: [{ label: t.contact, value: resolveContactName(contact) }],
        }));
      },
      run: runContactDelete,
    },
    "favorite.set": {
      title: "Set contact favorite",
      description: "Set or clear the current user's favorite state for one readable contact.",
      input: FavoriteSetInputSchema,
      data: FavoriteSetDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const { t } = contactCapabilityMessages.resolve([context.locale]);
        if (!userBacked(context)) return fail(err.forbidden("Favorites require a user-backed actor"));
        return reviewContactAction(input.contactId, context, "read", (contact) => ({
          message: t.favoriteReview({ contact: resolveContactName(contact), favorite: input.favorite }),
          details: [{ label: t.contact, value: resolveContactName(contact) }],
          approvalScope: FAVORITES_APPROVAL_SCOPE,
        }));
      },
      run: runFavoriteSet,
    },
    "tag.change": {
      title: "Change contact tags",
      description: "Atomically add and remove book-scoped tags on one writable contact.",
      input: ContactTagChangeInputSchema,
      data: ContactTagChangeDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const { t } = contactCapabilityMessages.resolve([context.locale]);
        const resolved = await resolveContact(input.contactId, context, "write");
        if (!resolved.ok) return resolved;
        const [addTagIds, removeTagIds] = await Promise.all([
          resolveBookPublicIds("tags", resolved.data.bookId, input.addTagIds),
          resolveBookPublicIds("tags", resolved.data.bookId, input.removeTagIds),
        ]);
        if (!addTagIds || !removeTagIds) return fail(err.notFound("Tag"));
        const [contacts, tags] = await Promise.all([
          projectContacts([resolved.data.contact]),
          projectTags(await contactsService.tag.list({ bookId: resolved.data.bookId })),
        ]);
        const contact = contacts[0];
        if (!contact) return fail(err.notFound("Contact"));
        const names = new Map(tags.map((tag) => [tag.id, tag.name]));
        return ok({
          message: t.tagsReview({ contact: resolveContactName(contact) }),
          details: [
            { label: t.contact, value: resolveContactName(contact) },
            { label: t.add, value: input.addTagIds.map((id: string) => names.get(id) ?? id).join(", ") || t.none },
            { label: t.remove, value: input.removeTagIds.map((id: string) => names.get(id) ?? id).join(", ") || t.none },
          ],
          links: [{ rel: "open" as const, href: contactHref(contact) }],
          approvalScope: bookApprovalScope(contact.bookId),
        });
      },
      run: runTagChange,
    },
    "note.create": {
      title: "Create contact note",
      description: "Append a user-authored note to one writable contact exactly once.",
      input: ContactNoteCreateInputSchema,
      data: ContactNoteCreateDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      approval: "rememberable",
      review: async (input, context) => {
        const { t } = contactCapabilityMessages.resolve([context.locale]);
        if (!userBacked(context)) return fail(err.forbidden("Notes require a user-backed actor"));
        return reviewContactAction(input.contactId, context, "write", (contact) => ({
          message: t.noteReview({ contact: resolveContactName(contact) }),
          details: [
            { label: t.contact, value: resolveContactName(contact) },
            { label: t.note, value: input.content, display: "block" },
          ],
          approvalScope: contactApprovalScope(contact.id),
        }));
      },
      run: runNoteCreate,
    },
  },
});
