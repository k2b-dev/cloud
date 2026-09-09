import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { SHORT_ID_REGEX } from "../lib/short-id";
import type { ContactLiveEvent, ContactServiceEvent } from "../live-events";
import type {
  Contact,
  ContactBook,
  ContactDuplicateMatch,
  ContactFavorite,
  ContactNote,
  ContactRef,
  ContactTag,
  ContactTree,
  ContactTreeNode,
} from "./types";

export type ContactResourceTable = "books" | "contacts" | "tags" | "notes";
export type BookOwnedResourceTable = "contacts" | "tags";

export const resolvePublicId = async (table: ContactResourceTable, shortId: string): Promise<string | null> => {
  if (!SHORT_ID_REGEX.test(shortId)) return null;
  let rows: { id: string }[];
  switch (table) {
    case "books":
      rows = await sql`SELECT id FROM contacts.books WHERE short_id = ${shortId}`;
      break;
    case "contacts":
      rows = await sql`SELECT id FROM contacts.contacts WHERE short_id = ${shortId}`;
      break;
    case "tags":
      rows = await sql`SELECT id FROM contacts.tags WHERE short_id = ${shortId}`;
      break;
    case "notes":
      rows = await sql`SELECT id FROM contacts.contact_notes WHERE short_id = ${shortId}`;
      break;
  }
  return rows[0]?.id ?? null;
};

export const resolvePublicIds = async (table: ContactResourceTable, values: string[]): Promise<string[] | null> => {
  if (values.length === 0) return [];
  const unique = [...new Set(values)];
  if (unique.some((value) => !SHORT_ID_REGEX.test(value))) return null;
  const input = toPgTextArray(unique);
  let rows: { id: string; short_id: string }[];
  switch (table) {
    case "books":
      rows = await sql`SELECT id, short_id FROM contacts.books WHERE short_id = ANY(${input}::text[])`;
      break;
    case "contacts":
      rows = await sql`SELECT id, short_id FROM contacts.contacts WHERE short_id = ANY(${input}::text[])`;
      break;
    case "tags":
      rows = await sql`SELECT id, short_id FROM contacts.tags WHERE short_id = ANY(${input}::text[])`;
      break;
    case "notes":
      rows = await sql`SELECT id, short_id FROM contacts.contact_notes WHERE short_id = ANY(${input}::text[])`;
      break;
  }
  const byShortId = new Map(rows.map((row) => [row.short_id, row.id]));
  return unique.every((value) => byShortId.has(value)) ? values.map((value) => byShortId.get(value)!) : null;
};

export const resolveBookPublicIds = async (table: BookOwnedResourceTable, bookId: string, values: string[]): Promise<string[] | null> => {
  if (values.length === 0) return [];
  const unique = [...new Set(values)];
  if (unique.some((value) => !SHORT_ID_REGEX.test(value))) return null;
  const input = toPgTextArray(unique);
  const rows =
    table === "contacts"
      ? await sql<{ id: string; short_id: string }[]>`
          SELECT id, short_id FROM contacts.contacts
          WHERE book_id = ${bookId}::uuid AND short_id = ANY(${input}::text[])
        `
      : await sql<{ id: string; short_id: string }[]>`
          SELECT id, short_id FROM contacts.tags
          WHERE book_id = ${bookId}::uuid AND short_id = ANY(${input}::text[])
        `;
  const byShortId = new Map(rows.map((row) => [row.short_id, row.id]));
  return unique.every((value) => byShortId.has(value)) ? values.map((value) => byShortId.get(value)!) : null;
};

const shortIds = async (table: ContactResourceTable, ids: (string | null | undefined)[]): Promise<Map<string, string>> => {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const input = toPgUuidArray(unique);
  let rows: { id: string; short_id: string }[];
  switch (table) {
    case "books":
      rows = await sql`SELECT id, short_id FROM contacts.books WHERE id = ANY(${input}::uuid[])`;
      break;
    case "contacts":
      rows = await sql`SELECT id, short_id FROM contacts.contacts WHERE id = ANY(${input}::uuid[])`;
      break;
    case "tags":
      rows = await sql`SELECT id, short_id FROM contacts.tags WHERE id = ANY(${input}::uuid[])`;
      break;
    case "notes":
      rows = await sql`SELECT id, short_id FROM contacts.contact_notes WHERE id = ANY(${input}::uuid[])`;
      break;
  }
  return new Map(rows.map((row) => [row.id, row.short_id]));
};

const required = (ids: Map<string, string>, id: string): string => {
  const value = ids.get(id);
  if (!value) throw new Error(`Missing public ID for Contacts resource ${id}`);
  return value;
};

export const projectBooks = async <T extends ContactBook>(items: T[]): Promise<T[]> => {
  const ids = await shortIds(
    "books",
    items.map((item) => item.id),
  );
  return items.map((item) => ({ ...item, id: required(ids, item.id) }));
};

export const projectTags = async <T extends ContactTag>(items: T[]): Promise<T[]> => {
  const [ids, books] = await Promise.all([
    shortIds(
      "tags",
      items.map((item) => item.id),
    ),
    shortIds(
      "books",
      items.map((item) => item.bookId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: required(ids, item.id), bookId: required(books, item.bookId) }));
};

const projectRef = (ref: ContactRef, contacts: Map<string, string>): ContactRef => ({ ...ref, id: required(contacts, ref.id) });

export const projectContacts = async <T extends Contact>(items: T[]): Promise<T[]> => {
  const relatedContactIds = items.flatMap((item) => [
    item.id,
    item.parentContactId,
    item.parent?.id,
    ...item.members.map((member) => member.id),
  ]);
  const tagIds = items.flatMap((item) => item.tags.map((tag) => tag.id));
  const [contacts, books, tags] = await Promise.all([
    shortIds("contacts", relatedContactIds),
    shortIds(
      "books",
      items.map((item) => item.bookId),
    ),
    shortIds("tags", tagIds),
  ]);
  return items.map((item) => {
    const id = required(contacts, item.id);
    const bookId = required(books, item.bookId);
    return {
      ...item,
      id,
      bookId,
      emails: item.emails.map((value) => ({ ...value, contactId: id })),
      phones: item.phones.map((value) => ({ ...value, contactId: id })),
      addresses: item.addresses.map((value) => ({ ...value, contactId: id })),
      websites: item.websites.map((value) => ({ ...value, contactId: id })),
      bankAccounts: item.bankAccounts.map((value) => ({ ...value, contactId: id })),
      parentContactId: item.parentContactId ? required(contacts, item.parentContactId) : null,
      parent: item.parent ? projectRef(item.parent, contacts) : null,
      members: item.members.map((member) => projectRef(member, contacts)),
      tags: item.tags.map((tag) => ({ ...tag, id: required(tags, tag.id), bookId })),
    };
  });
};

export const projectNotes = async <T extends ContactNote>(items: T[]): Promise<T[]> => {
  const [notes, contacts] = await Promise.all([
    shortIds(
      "notes",
      items.map((item) => item.id),
    ),
    shortIds(
      "contacts",
      items.map((item) => item.contactId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: required(notes, item.id), contactId: required(contacts, item.contactId) }));
};

const projectTreeNode = (node: ContactTreeNode, contacts: Map<string, string>): ContactTreeNode => ({
  ...node,
  id: required(contacts, node.id),
  parentContactId: node.parentContactId ? required(contacts, node.parentContactId) : null,
  children: node.children.map((child) => projectTreeNode(child, contacts)),
});

export const projectTrees = async (items: ContactTree[]): Promise<ContactTree[]> => {
  const nodes = (node: ContactTreeNode): string[] => [
    node.id,
    ...(node.parentContactId ? [node.parentContactId] : []),
    ...node.children.flatMap(nodes),
  ];
  const [books, contacts] = await Promise.all([
    shortIds(
      "books",
      items.map((item) => item.bookId),
    ),
    shortIds(
      "contacts",
      items.flatMap((item) => [item.selectedId, ...nodes(item.root)]),
    ),
  ]);
  return items.map((item) => ({
    ...item,
    bookId: required(books, item.bookId),
    selectedId: required(contacts, item.selectedId),
    root: projectTreeNode(item.root, contacts),
  }));
};

export const projectFavorites = async (items: ContactFavorite[]): Promise<ContactFavorite[]> => {
  const [books, contacts] = await Promise.all([
    shortIds(
      "books",
      items.map((item) => item.bookId),
    ),
    shortIds(
      "contacts",
      items.map((item) => item.contactId),
    ),
  ]);
  return items.map((item) => ({ ...item, bookId: required(books, item.bookId), contactId: required(contacts, item.contactId) }));
};

export const projectFavoriteKeys = async (items: Contact[], keys: string[]): Promise<string[]> => {
  const projected = await projectContacts(items);
  const byInternalKey = new Map(
    items.map((item, index) => [`${item.bookId}:${item.id}`, `${projected[index]!.bookId}:${projected[index]!.id}`]),
  );
  return keys.map((key) => byInternalKey.get(key)).filter((key): key is string => Boolean(key));
};

export const projectContactReferences = async <T extends { contactId: string; bookId: string }>(items: T[]): Promise<T[]> => {
  const [books, contacts] = await Promise.all([
    shortIds(
      "books",
      items.map((item) => item.bookId),
    ),
    shortIds(
      "contacts",
      items.map((item) => item.contactId),
    ),
  ]);
  return items.map((item) => ({
    ...item,
    contactId: required(contacts, item.contactId),
    bookId: required(books, item.bookId),
  }));
};

export const projectDuplicates = async (items: ContactDuplicateMatch[]): Promise<ContactDuplicateMatch[]> => {
  const contacts = await projectContacts(items.flatMap((item) => [item.first, item.second]));
  return items.map((item, index) => ({ ...item, first: contacts[index * 2]!, second: contacts[index * 2 + 1]! }));
};

export const projectContactEventIds = async (event: ContactServiceEvent): Promise<ContactLiveEvent> => {
  const bookIds = event.type === "contact.moved" ? [event.sourceBookId, event.targetBookId] : [event.bookId];
  const contactIds = "contactId" in event ? [event.contactId] : [];
  const [books, contacts] = await Promise.all([shortIds("books", bookIds), shortIds("contacts", contactIds)]);
  if (event.type === "contact.moved") {
    return {
      ...event,
      sourceBookId: required(books, event.sourceBookId),
      targetBookId: required(books, event.targetBookId),
      contactId: required(contacts, event.contactId),
    };
  }
  return {
    ...event,
    bookId: required(books, event.bookId),
    ...("contactId" in event ? { contactId: required(contacts, event.contactId) } : {}),
  } as ContactLiveEvent;
};
