import { readFile, writeFile } from "node:fs/promises";
import {
  arg,
  type CloudCliContext,
  type CloudCliFlags,
  command,
  createAccessCommands,
  defineCliCommands,
  flag,
  printRows as printJsonOrTable,
  printStructured,
} from "@k2b/cloud/cli";
import type { AccessEntry, PermissionLevel, Principal } from "@k2b/cloud/contracts";
import type {
  Contact,
  ContactBook,
  ContactNote,
  ContactTag,
  CreateBookInput,
  CreateContactInput,
  CreateContactNoteInput,
  CreateContactTagInput,
  UpdateBookInput,
  UpdateContactInput,
  UpdateContactNoteInput,
  UpdateContactTagInput,
} from "./service/types";
import { resolveContactName } from "./shared";

type Pagination = {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  has_next: boolean;
};

type Page<T> = {
  data: T[];
  pagination: Pagination;
};

type ImportPreviewResponse = {
  candidates: unknown[];
};

type ContactTreeNode = {
  id: string;
  label?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  jobTitle?: string | null;
  children?: ContactTreeNode[];
};

type ContactTree = {
  root: ContactTreeNode;
  selectedId: string;
};

const CONTACTS_BOOK_DEFAULT_KEY = "contacts.book";
const RESOURCE_ID_PATTERN = /^[0-9A-Za-z]{6}$/;

const stringFlag = (flags: CloudCliFlags, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.at(-1);
  }
  return undefined;
};

const stringFlags = (flags: CloudCliFlags, name: string): string[] => {
  const value = flags[name];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
};

const booleanFlag = (flags: CloudCliFlags, ...names: string[]): boolean => names.some((name) => flags[name] === true);

const requireArg = (args: string[], index: number, label: string): string => {
  const value = args[index];
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
};

const requireResourceId = (value: string, label: string): string => {
  if (!isResourceId(value)) throw new Error(`${label} must be a six-character Contacts ID.`);
  return value;
};

const isResourceId = (value: string): boolean => RESOURCE_ID_PATTERN.test(value);
const isHttpStatus = (error: unknown, status: number): boolean => error instanceof Error && error.message.startsWith(`${status} `);

const apiPath = (path = "") => `/api/contacts${path === "/" ? "" : path}`;

const readApi = async <T>(ctx: CloudCliContext, path: string, init?: RequestInit): Promise<T> =>
  ctx.readJson<T>(await ctx.fetch(apiPath(path), init));

const jsonRequest = (method: string, value: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

const readTextResponse = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const message = (() => {
      try {
        const payload = JSON.parse(text) as { message?: unknown; error?: unknown };
        return String(payload.message ?? payload.error ?? (text.trim() || response.statusText));
      } catch {
        return text.trim() || response.statusText;
      }
    })();
    throw new Error(`${response.status} ${message}`);
  }
  return text;
};

const parsePositiveInt = (value: string | undefined, fallback: number, label: string): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
};

const paginationQuery = (ctx: CloudCliContext): Record<string, string> => ({
  page: String(parsePositiveInt(stringFlag(ctx.flags, "page"), 1, "--page")),
  per_page: String(parsePositiveInt(stringFlag(ctx.flags, "per-page", "per_page"), 50, "--per-page")),
});

const readInputContent = async (ctx: CloudCliContext, required = true): Promise<string | undefined> => {
  const literal = stringFlag(ctx.flags, "content");
  const file = stringFlag(ctx.flags, "file", "f");
  const stdin = booleanFlag(ctx.flags, "stdin");
  const sources = [literal !== undefined, file !== undefined, stdin].filter(Boolean).length;
  if (sources > 1) throw new Error("Pass only one of --content, --file, or --stdin.");
  if (literal !== undefined) return literal;
  if (file) return readFile(file, "utf8");
  if (stdin) return Bun.stdin.text();
  if (required) throw new Error("Missing content. Pass --content, --file, or --stdin.");
  return undefined;
};

const readJsonInput = async <T>(ctx: CloudCliContext): Promise<T | undefined> => {
  const file = stringFlag(ctx.flags, "json-input");
  const stdin = booleanFlag(ctx.flags, "stdin");
  const sources = [file !== undefined, stdin].filter(Boolean).length;
  if (sources > 1) throw new Error("Pass only one of --json-input or --stdin.");
  if (!file && !stdin) return undefined;
  const text = file ? await readFile(file, "utf8") : await Bun.stdin.text();
  return JSON.parse(text) as T;
};

const parsePairValue = (value: string, valueKey: "email" | "phone") => {
  const equalsIndex = value.indexOf("=");
  if (equalsIndex === -1) return { [valueKey]: value };
  return {
    label: value.slice(0, equalsIndex) || null,
    [valueKey]: value.slice(equalsIndex + 1),
  };
};

const formatBookCandidates = (items: ContactBook[]): string =>
  items
    .slice(0, 5)
    .map((item) => `${item.name} (${item.id})`)
    .join(", ");

const formatContactCandidates = (items: Contact[]): string =>
  items
    .slice(0, 5)
    .map((item) => `${resolveContactName(item)} (${item.id})`)
    .join(", ");

const formatTagCandidates = (items: ContactTag[]): string =>
  items
    .slice(0, 5)
    .map((item) => `${item.name} (${item.id})`)
    .join(", ");

const bookRows = (items: ContactBook[]) =>
  items.map((book) => ({
    id: book.id,
    name: book.name,
    updatedAt: book.updatedAt ?? "",
  }));

const contactRows = (items: Contact[]) =>
  items.map((contact) => ({
    id: contact.id,
    name: resolveContactName(contact),
    email: contact.emails[0]?.email ?? "",
    phone: contact.phones[0]?.phone ?? "",
    company: contact.companyName ?? "",
    updatedAt: contact.updatedAt,
  }));

const tagRows = (items: ContactTag[]) =>
  items.map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
  }));

const noteRows = (items: ContactNote[]) =>
  items.map((note) => ({
    id: note.id,
    author: note.authorDisplayName,
    content: note.content.replace(/\s+/g, " ").slice(0, 80),
    createdAt: note.createdAt,
  }));

const listBooks = async (ctx: CloudCliContext, query?: string): Promise<Page<ContactBook>> =>
  readApi<Page<ContactBook>>(
    ctx,
    `/books?${new URLSearchParams({
      ...paginationQuery(ctx),
      ...(query ? { q: query } : {}),
    }).toString()}`,
  );

const resolveBookRef = async (ctx: CloudCliContext, ref: string): Promise<ContactBook> => {
  if (isResourceId(ref)) {
    try {
      return await readApi<ContactBook>(ctx, `/books/${ref}`);
    } catch (error) {
      if (!isHttpStatus(error, 404)) throw error;
    }
  }

  const page = await listBooks(ctx, ref);
  const matches = page.data.filter((book) => book.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Book "${ref}" is ambiguous. Use one of: ${formatBookCandidates(matches)}`);
  const candidates = formatBookCandidates(page.data);
  throw new Error(
    candidates
      ? `Book "${ref}" was not found by id or exact name. Similar matches: ${candidates}`
      : `Book "${ref}" was not found by id or exact name.`,
  );
};

const requireDefaultBookRef = async (ctx: CloudCliContext): Promise<string> => {
  const ref = await ctx.getDefault(CONTACTS_BOOK_DEFAULT_KEY);
  if (!ref) throw new Error("Missing book. Pass --book <book> or run `cld contacts use <book>`.");
  return ref;
};

const resolveBookArg = async (
  ctx: CloudCliContext,
  args: string[],
  requiredTrailingArgs: number,
): Promise<{ bookRef: string; rest: string[] }> => {
  const flagged = stringFlag(ctx.flags, "book");
  if (flagged) return { bookRef: flagged, rest: args };
  if (args.length > requiredTrailingArgs) return { bookRef: requireArg(args, 0, "book"), rest: args.slice(1) };
  return { bookRef: await requireDefaultBookRef(ctx), rest: args };
};

const resolveTagRefFromList = (tags: ContactTag[], ref: string): ContactTag => {
  if (isResourceId(ref)) {
    const tag = tags.find((item) => item.id === ref);
    if (tag) return tag;
  }
  const matches = tags.filter((item) => item.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Tag "${ref}" is ambiguous. Use one of: ${formatTagCandidates(matches)}`);
  const candidates = formatTagCandidates(tags.filter((item) => item.name.toLowerCase().includes(ref.toLowerCase())));
  throw new Error(candidates ? `Tag "${ref}" was not found. Similar matches: ${candidates}` : `Tag "${ref}" was not found.`);
};

const resolveTagRef = async (ctx: CloudCliContext, bookId: string, ref: string): Promise<ContactTag> => {
  const tags = await readApi<ContactTag[]>(ctx, `/books/${bookId}/tags`);
  return resolveTagRefFromList(tags, ref);
};

const resolveTagIds = async (ctx: CloudCliContext, bookId: string, refs: string[]): Promise<string[]> => {
  const tags = await readApi<ContactTag[]>(ctx, `/books/${bookId}/tags`);
  const ids = refs.map((ref) => resolveTagRefFromList(tags, ref).id);
  return Array.from(new Set(ids));
};

const resolveContactRef = async (ctx: CloudCliContext, bookId: string, ref: string): Promise<Contact> => {
  if (isResourceId(ref)) {
    try {
      return await readApi<Contact>(ctx, `/books/${bookId}/contacts/${ref}`);
    } catch (error) {
      if (!isHttpStatus(error, 404)) throw error;
    }
  }

  const page = await readApi<Page<Contact>>(
    ctx,
    `/books/${bookId}/contacts?${new URLSearchParams({ ...paginationQuery(ctx), q: ref }).toString()}`,
  );
  const matches = page.data.filter((contact) => resolveContactName(contact) === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Contact "${ref}" is ambiguous. Use one of: ${formatContactCandidates(matches)}`);
  const candidates = formatContactCandidates(page.data);
  throw new Error(candidates ? `Contact "${ref}" was not found. Similar matches: ${candidates}` : `Contact "${ref}" was not found.`);
};

const resolveContactCommandArgs = async (
  ctx: CloudCliContext,
  args: string[],
  requiredTrailingAfterContact = 0,
): Promise<{ book: ContactBook; contact: Contact; rest: string[] }> => {
  const flaggedContact = stringFlag(ctx.flags, "contact");
  if (flaggedContact) {
    const { bookRef, rest } = await resolveBookArg(ctx, args, requiredTrailingAfterContact);
    const book = await resolveBookRef(ctx, bookRef);
    return { book, contact: await resolveContactRef(ctx, book.id, flaggedContact), rest };
  }

  const { bookRef, rest } = await resolveBookArg(ctx, args, requiredTrailingAfterContact + 1);
  const book = await resolveBookRef(ctx, bookRef);
  return { book, contact: await resolveContactRef(ctx, book.id, requireArg(rest, 0, "contact")), rest: rest.slice(1) };
};

const buildContactPayload = async <T extends CreateContactInput | UpdateContactInput>(ctx: CloudCliContext, bookId: string): Promise<T> => {
  const payload = ((await readJsonInput<T>(ctx)) ?? {}) as Record<string, unknown>;
  const setString = (field: keyof CreateContactInput, ...flags: string[]) => {
    const value = stringFlag(ctx.flags, ...flags);
    if (value !== undefined) payload[field] = value;
  };

  setString("label", "label");
  setString("firstName", "first-name", "firstName");
  setString("lastName", "last-name", "lastName");
  setString("companyName", "company-name", "companyName");
  setString("department", "department");
  setString("jobTitle", "job-title", "jobTitle");
  setString("vatId", "vat-id", "vatId");
  setString("birthday", "birthday");
  setString("salutation", "salutation");
  setString("pronouns", "pronouns");
  setString("preferredLanguage", "preferred-language", "preferredLanguage");
  setString("source", "source");

  const parent = stringFlag(ctx.flags, "parent", "parent-contact");
  if (parent !== undefined) payload.parentContactId = parent === "none" ? null : (await resolveContactRef(ctx, bookId, parent)).id;

  const emails = stringFlags(ctx.flags, "email");
  if (emails.length > 0) payload.emails = emails.map((email) => parsePairValue(email, "email"));

  const phones = stringFlags(ctx.flags, "phone");
  if (phones.length > 0) payload.phones = phones.map((phone) => parsePairValue(phone, "phone"));

  const tags = stringFlags(ctx.flags, "tag");
  if (tags.length > 0) payload.tagIds = await resolveTagIds(ctx, bookId, tags);

  return payload as T;
};

const assertHasPayload = (payload: Record<string, unknown>, command: string) => {
  if (Object.keys(payload).length === 0) throw new Error(`No contact fields to ${command}.`);
};

const contactTreeNodeName = (node: ContactTreeNode): string =>
  node.label || [node.firstName, node.lastName].filter(Boolean).join(" ") || node.companyName || node.id;

const formatContactTree = (tree: ContactTree): string => {
  const lines: string[] = [];
  const visit = (node: ContactTreeNode, depth: number) => {
    const marker = node.id === tree.selectedId ? "*" : "-";
    const suffix = node.jobTitle ? ` (${node.jobTitle})` : "";
    lines.push(`${"  ".repeat(depth)}${marker} ${contactTreeNodeName(node)}${suffix}`);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(tree.root, 0);
  return lines.join("\n");
};

const runContactsCommand = async (ctx: CloudCliContext, command: string, args: string[]) => {
  if (command === "books") {
    const payload = await listBooks(ctx, stringFlag(ctx.flags, "q", "query"));
    printJsonOrTable(ctx, payload, bookRows(payload.data), [
      { key: "name", label: "NAME" },
      { key: "updatedAt", label: "UPDATED" },
      { key: "id", label: "ID" },
    ]);
    return 0;
  }

  if (command === "use") {
    const book = await resolveBookRef(ctx, requireArg(args, 0, "book"));
    await ctx.setDefault(CONTACTS_BOOK_DEFAULT_KEY, book.id);
    if (!printStructured(ctx, { book, defaultBook: book.id })) ctx.print(`Using contact book ${book.name} (${book.id}).`);
    return 0;
  }

  if (command === "current") {
    const bookRef = await ctx.getDefault(CONTACTS_BOOK_DEFAULT_KEY);
    if (!bookRef) throw new Error("No default contact book configured. Run `cld contacts use <book>`.");
    const book = await resolveBookRef(ctx, bookRef);
    if (!printStructured(ctx, { book, defaultBook: book.id })) ctx.print(`${book.name} (${book.id})`);
    return 0;
  }

  if (command === "book") {
    const { bookRef } = await resolveBookArg(ctx, args, 0);
    const book = await resolveBookRef(ctx, bookRef);
    if (!printStructured(ctx, book)) {
      ctx.print(`${book.name} (${book.id})`);
      if (book.description) ctx.print(book.description);
    }
    return 0;
  }

  if (command === "create-book") {
    const data: CreateBookInput = {
      name: requireArg(args, 0, "book name"),
      ...(stringFlag(ctx.flags, "description") ? { description: stringFlag(ctx.flags, "description") } : {}),
    };
    const book = await readApi<ContactBook>(ctx, "/books", jsonRequest("POST", data));
    if (booleanFlag(ctx.flags, "use")) await ctx.setDefault(CONTACTS_BOOK_DEFAULT_KEY, book.id);
    if (!printStructured(ctx, book))
      ctx.print(`Created ${book.name} (${book.id}).${booleanFlag(ctx.flags, "use") ? " Using it as default." : ""}`);
    return 0;
  }

  if (command === "update-book") {
    const { bookRef } = await resolveBookArg(ctx, args, 0);
    const book = await resolveBookRef(ctx, bookRef);
    const data: UpdateBookInput = {};
    const name = stringFlag(ctx.flags, "name");
    const description = stringFlag(ctx.flags, "description");
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (Object.keys(data).length === 0) throw new Error("No book fields to update.");
    const updated = await readApi<ContactBook>(ctx, `/books/${book.id}`, jsonRequest("PATCH", data));
    if (!printStructured(ctx, updated)) ctx.print(`Updated ${updated.name} (${updated.id}).`);
    return 0;
  }

  if (command === "delete-book") {
    const { bookRef } = await resolveBookArg(ctx, args, 0);
    const book = await resolveBookRef(ctx, bookRef);
    const payload = await readApi<unknown>(ctx, `/books/${book.id}`, { method: "DELETE" });
    if (!printStructured(ctx, payload)) ctx.print(`Deleted ${book.name} (${book.id}).`);
    return 0;
  }

  if (command === "list") {
    const { bookRef } = await resolveBookArg(ctx, args, 0);
    const book = await resolveBookRef(ctx, bookRef);
    const tagRefs = stringFlags(ctx.flags, "tag");
    const tagIds = await resolveTagIds(ctx, book.id, tagRefs);
    const query = new URLSearchParams({
      ...paginationQuery(ctx),
      ...(stringFlag(ctx.flags, "q", "query") ? { q: stringFlag(ctx.flags, "q", "query")! } : {}),
    });
    for (const tagId of tagIds) query.append("tag_id", tagId);
    const payload = await readApi<Page<Contact>>(ctx, `/books/${book.id}/contacts?${query.toString()}`);
    printJsonOrTable(ctx, payload, contactRows(payload.data), [
      { key: "name", label: "NAME" },
      { key: "email", label: "EMAIL" },
      { key: "phone", label: "PHONE" },
      { key: "company", label: "COMPANY" },
      { key: "updatedAt", label: "UPDATED" },
      { key: "id", label: "ID" },
    ]);
    return 0;
  }

  if (command === "get") {
    const { contact } = await resolveContactCommandArgs(ctx, args);
    if (!printStructured(ctx, contact)) {
      ctx.print(`${resolveContactName(contact)} (${contact.id})`);
      if (contact.jobTitle || contact.companyName) ctx.print([contact.jobTitle, contact.companyName].filter(Boolean).join(", "));
      if (contact.emails.length > 0) ctx.print(`email: ${contact.emails.map((email) => email.email).join(", ")}`);
      if (contact.phones.length > 0) ctx.print(`phone: ${contact.phones.map((phone) => phone.phone).join(", ")}`);
      if (contact.tags.length > 0) ctx.print(`tags: ${contact.tags.map((tag) => tag.name).join(", ")}`);
    }
    return 0;
  }

  if (command === "search") {
    const queryText = args.join(" ").trim() || stringFlag(ctx.flags, "q", "query");
    if (!queryText) throw new Error("Missing search query.");
    const payload = await readApi<Page<Contact>>(
      ctx,
      `/search?${new URLSearchParams({
        ...paginationQuery(ctx),
        q: queryText,
      }).toString()}`,
    );
    printJsonOrTable(ctx, payload, contactRows(payload.data), [
      { key: "name", label: "NAME" },
      { key: "email", label: "EMAIL" },
      { key: "phone", label: "PHONE" },
      { key: "company", label: "COMPANY" },
      { key: "id", label: "ID" },
    ]);
    return 0;
  }

  if (command === "create") {
    const { bookRef } = await resolveBookArg(ctx, args, 0);
    const book = await resolveBookRef(ctx, bookRef);
    const data = await buildContactPayload<CreateContactInput>(ctx, book.id);
    assertHasPayload(data as Record<string, unknown>, "create");
    const contact = await readApi<Contact>(ctx, `/books/${book.id}/contacts`, jsonRequest("POST", data));
    if (!printStructured(ctx, contact)) ctx.print(`Created ${resolveContactName(contact)} (${contact.id}).`);
    return 0;
  }

  if (command === "update") {
    const { book, contact } = await resolveContactCommandArgs(ctx, args);
    const data = await buildContactPayload<UpdateContactInput>(ctx, book.id);
    assertHasPayload(data as Record<string, unknown>, "update");
    const updated = await readApi<Contact>(ctx, `/books/${book.id}/contacts/${contact.id}`, jsonRequest("PATCH", data));
    if (!printStructured(ctx, updated)) ctx.print(`Updated ${resolveContactName(updated)} (${updated.id}).`);
    return 0;
  }

  if (command === "delete") {
    const { book, contact } = await resolveContactCommandArgs(ctx, args);
    const payload = await readApi<unknown>(ctx, `/books/${book.id}/contacts/${contact.id}`, { method: "DELETE" });
    if (!printStructured(ctx, payload)) ctx.print(`Deleted ${resolveContactName(contact)} (${contact.id}).`);
    return 0;
  }

  if (command === "move") {
    const { book, contact } = await resolveContactCommandArgs(ctx, args);
    const targetBookRef = stringFlag(ctx.flags, "target-book", "targetBookId");
    if (!targetBookRef) throw new Error("Missing target book. Pass --target-book <book>.");
    const targetBook = await resolveBookRef(ctx, targetBookRef);
    const moved = await readApi<Contact>(
      ctx,
      `/books/${book.id}/contacts/${contact.id}/move`,
      jsonRequest("POST", { targetBookId: targetBook.id }),
    );
    if (!printStructured(ctx, moved)) ctx.print(`Moved ${resolveContactName(moved)} to ${targetBook.name}.`);
    return 0;
  }

  if (command === "tree") {
    const { book, contact } = await resolveContactCommandArgs(ctx, args);
    const tree = await readApi<ContactTree>(ctx, `/books/${book.id}/contacts/${contact.id}/tree`);
    if (!printStructured(ctx, tree)) ctx.print(formatContactTree(tree));
    return 0;
  }

  if (command === "notes" || command === "note" || command === "update-note" || command === "delete-note") {
    const { book, contact, rest } = await resolveContactCommandArgs(
      ctx,
      args,
      command === "update-note" || command === "delete-note" ? 1 : 0,
    );

    if (command === "notes") {
      const notes = await readApi<ContactNote[]>(ctx, `/books/${book.id}/contacts/${contact.id}/notes`);
      printJsonOrTable(ctx, notes, noteRows(notes), [
        { key: "createdAt", label: "CREATED" },
        { key: "author", label: "AUTHOR" },
        { key: "content", label: "CONTENT" },
        { key: "id", label: "ID" },
      ]);
      return 0;
    }

    if (command === "note") {
      const content = await readInputContent(ctx);
      const data: CreateContactNoteInput = { content: content ?? "" };
      const note = await readApi<ContactNote>(ctx, `/books/${book.id}/contacts/${contact.id}/notes`, jsonRequest("POST", data));
      if (!printStructured(ctx, note)) ctx.print(`Created note ${note.id}.`);
      return 0;
    }

    const noteId = requireResourceId(requireArg(rest, 0, "note"), "Note");
    if (command === "update-note") {
      const content = await readInputContent(ctx);
      const data: UpdateContactNoteInput = { content: content ?? "" };
      const note = await readApi<ContactNote>(ctx, `/books/${book.id}/contacts/${contact.id}/notes/${noteId}`, jsonRequest("PATCH", data));
      if (!printStructured(ctx, note)) ctx.print(`Updated note ${note.id}.`);
      return 0;
    }

    const payload = await readApi<unknown>(ctx, `/books/${book.id}/contacts/${contact.id}/notes/${noteId}`, { method: "DELETE" });
    if (!printStructured(ctx, payload)) ctx.print(`Deleted note ${noteId}.`);
    return 0;
  }

  if (command === "tags" || command === "create-tag" || command === "update-tag" || command === "delete-tag") {
    const { bookRef, rest } = await resolveBookArg(
      ctx,
      args,
      command === "create-tag" || command === "update-tag" || command === "delete-tag" ? 1 : 0,
    );
    const book = await resolveBookRef(ctx, bookRef);

    if (command === "tags") {
      const tags = await readApi<ContactTag[]>(ctx, `/books/${book.id}/tags`);
      printJsonOrTable(ctx, tags, tagRows(tags), [
        { key: "name", label: "NAME" },
        { key: "color", label: "COLOR" },
        { key: "id", label: "ID" },
      ]);
      return 0;
    }

    if (command === "create-tag") {
      const color = stringFlag(ctx.flags, "color");
      if (!color) throw new Error("Missing color. Pass --color <#RRGGBB>.");
      const data: CreateContactTagInput = { name: requireArg(rest, 0, "tag name"), color };
      const tag = await readApi<ContactTag>(ctx, `/books/${book.id}/tags`, jsonRequest("POST", data));
      if (!printStructured(ctx, tag)) ctx.print(`Created tag ${tag.name} (${tag.id}).`);
      return 0;
    }

    const tag = await resolveTagRef(ctx, book.id, requireArg(rest, 0, "tag"));
    if (command === "update-tag") {
      const data: UpdateContactTagInput = {};
      const name = stringFlag(ctx.flags, "name");
      const color = stringFlag(ctx.flags, "color");
      if (name !== undefined) data.name = name;
      if (color !== undefined) data.color = color;
      if (Object.keys(data).length === 0) throw new Error("No tag fields to update.");
      const updated = await readApi<ContactTag>(ctx, `/books/${book.id}/tags/${tag.id}`, jsonRequest("PATCH", data));
      if (!printStructured(ctx, updated)) ctx.print(`Updated tag ${updated.name} (${updated.id}).`);
      return 0;
    }

    const payload = await readApi<unknown>(ctx, `/books/${book.id}/tags/${tag.id}`, { method: "DELETE" });
    if (!printStructured(ctx, payload)) ctx.print(`Deleted tag ${tag.name} (${tag.id}).`);
    return 0;
  }

  if (command === "export") {
    const { bookRef } = await resolveBookArg(ctx, args, 0);
    const book = await resolveBookRef(ctx, bookRef);
    const format = stringFlag(ctx.flags, "format") ?? "vcf";
    if (format !== "vcf" && format !== "csv") throw new Error("--format must be vcf or csv.");
    const body = await readTextResponse(await ctx.fetch(apiPath(`/books/${book.id}/export.${format}`)));
    const out = stringFlag(ctx.flags, "out", "output");
    if (out) {
      await writeFile(out, body);
      ctx.print(`Wrote ${out}.`);
    } else {
      ctx.print(body);
    }
    return 0;
  }

  if (command === "import-preview") {
    const { bookRef } = await resolveBookArg(ctx, args, 0);
    const book = await resolveBookRef(ctx, bookRef);
    const content = await readInputContent(ctx);
    const payload = await readApi<ImportPreviewResponse>(
      ctx,
      `/books/${book.id}/import/preview`,
      jsonRequest("POST", { format: "vcard", content }),
    );
    ctx.json(payload);
    return 0;
  }

  throw new Error(`Unknown contacts command "${command}". Run \`cld contacts help\`.`);
};

const bookArg = {
  args: arg.rest({ valueLabel: "book-or-args", description: "Optional leading book followed by command arguments." }),
};

const paginationFlagSpecs = {
  page: flag.int({ min: 1, description: "Page number" }),
  perPage: flag.int({ name: "per-page", aliases: ["per_page"], min: 1, description: "Items per page" }),
};

const bookFlag = {
  book: flag.string({ description: "Contact book id or exact name" }),
};

const contactBookAccessCommands = createAccessCommands({
  resourceLabel: "contact book",
  resourceArgLabel: "book",
  resourceArgDescription: "Optional contact book id or exact name. If omitted, the default from `cld contacts use` is used.",
  resolveResource: async (ctx, args) => {
    const { bookRef, rest } = await resolveBookArg(ctx, args, 0);
    if (rest.length > 0) throw new Error(`Unexpected contact book access arguments: ${rest.join(" ")}`);
    const book = await resolveBookRef(ctx, bookRef);
    return {
      id: book.id,
      label: `${book.name} (${book.id})`,
    };
  },
  list: async (ctx, book) => readApi<AccessEntry[]>(ctx, `/books/${book.id}/access`),
  grant: async (ctx, book, principal: Principal, permission: PermissionLevel) =>
    readApi<AccessEntry>(ctx, `/books/${book.id}/access`, jsonRequest("POST", { principal, permission })),
  update: async (ctx, book, accessId, permission) => {
    await readApi<unknown>(ctx, `/books/${book.id}/access/${accessId}`, jsonRequest("PATCH", { permission }));
  },
  revoke: async (ctx, book, accessId) => {
    await readApi<unknown>(ctx, `/books/${book.id}/access/${accessId}`, { method: "DELETE" });
  },
  examples: {
    list: ['cld contacts access list "Customers"', "cld contacts access list --include-service-accounts"],
    grant: [
      'cld contacts access grant "Customers" --user valentin.kolb --permission read',
      'cld contacts access grant "Customers" --group "Editors" --permission write',
      'cld contacts access grant "Customers" --authenticated --permission read',
    ],
    set: [
      'cld contacts access set "Customers" --user valentin.kolb --permission admin',
      "cld contacts access set --access-id 00000000-0000-4000-8000-000000000000 --permission write",
    ],
    revoke: [
      'cld contacts access revoke "Customers" --user valentin.kolb --yes',
      "cld contacts access revoke --access-id 00000000-0000-4000-8000-000000000000 --yes",
    ],
    searchPrincipals: [
      "cld contacts access search-principals val --kind user,group",
      'cld contacts access search-principals "Editors" --kind group',
    ],
  },
});

const contactFlag = {
  contact: flag.string({ description: "Contact id or exact display name" }),
};

const contentFlagSpecs = {
  content: flag.string({ description: "Content text" }),
  file: flag.string({ aliases: ["f"], description: "Read content from file" }),
  stdin: flag.boolean({ description: "Read content or JSON input from stdin" }),
};

const contactFieldFlags = {
  label: flag.string({ description: "Contact label" }),
  firstName: flag.string({ name: "first-name", aliases: ["firstName"], description: "First name" }),
  lastName: flag.string({ name: "last-name", aliases: ["lastName"], description: "Last name" }),
  companyName: flag.string({ name: "company-name", aliases: ["companyName"], description: "Company name" }),
  department: flag.string({ description: "Department" }),
  jobTitle: flag.string({ name: "job-title", aliases: ["jobTitle"], description: "Job title" }),
  vatId: flag.string({ name: "vat-id", aliases: ["vatId"], description: "VAT id" }),
  birthday: flag.string({ description: "Birthday as YYYY-MM-DD" }),
  salutation: flag.string({ description: "Salutation" }),
  pronouns: flag.string({ description: "Pronouns" }),
  preferredLanguage: flag.string({ name: "preferred-language", aliases: ["preferredLanguage"], description: "Preferred language tag" }),
  source: flag.string({ description: "Source" }),
  email: flag.stringList({ description: "Email or label=email. Repeatable." }),
  phone: flag.stringList({ description: "Phone or label=phone. Repeatable." }),
  tag: flag.stringList({ description: "Tag id or exact name. Repeatable." }),
  parent: flag.string({ aliases: ["parent-contact"], description: 'Parent contact id/name, or "none" to clear' }),
  jsonInput: flag.string({ name: "json-input", description: "Read API payload JSON from file" }),
  stdin: flag.boolean({ description: "Read API payload JSON from stdin" }),
};

const contactTargetArgs = {
  args: arg.rest({ valueLabel: "book-contact-args", description: "Optional leading book, contact, and command-specific arguments." }),
};

export default defineCliCommands({
  name: "contacts",
  summary: "Manage contact books, contacts, notes, tags, and exports.",
  groupSummaries: {
    access: "Manage direct access to contact books",
  },
  commands: [
    command("books", {
      summary: "List contact books",
      flags: {
        q: flag.string({ aliases: ["query"], description: "Search query" }),
        ...paginationFlagSpecs,
      },
      run: ({ ctx }) => runContactsCommand(ctx, "books", []),
    }),
    command("use", {
      summary: "Set the default contact book",
      args: {
        book: arg.required({ description: "Contact book id or exact name" }),
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "use", [args.book]),
    }),
    command("current", {
      summary: "Show the default contact book",
      run: ({ ctx }) => runContactsCommand(ctx, "current", []),
    }),
    command("book", {
      summary: "Show a contact book",
      args: bookArg,
      flags: bookFlag,
      run: ({ ctx, args }) => runContactsCommand(ctx, "book", args.args),
    }),
    command("create-book", {
      summary: "Create a contact book",
      args: {
        name: arg.required({ description: "Book name" }),
      },
      flags: {
        description: flag.string({ description: "Book description" }),
        use: flag.boolean({ description: "Use the new book as default" }),
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "create-book", [args.name]),
    }),
    command("update-book", {
      summary: "Update a contact book",
      args: bookArg,
      flags: {
        ...bookFlag,
        name: flag.string({ description: "Book name" }),
        description: flag.string({ description: "Book description" }),
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "update-book", args.args),
    }),
    command("delete-book", {
      summary: "Delete a contact book",
      args: bookArg,
      flags: bookFlag,
      run: ({ ctx, args }) => runContactsCommand(ctx, "delete-book", args.args),
    }),
    ...contactBookAccessCommands,
    command("list", {
      summary: "List contacts",
      args: bookArg,
      flags: {
        ...bookFlag,
        q: flag.string({ aliases: ["query"], description: "Search query" }),
        tag: flag.stringList({ description: "Tag id or exact name. Repeatable." }),
        ...paginationFlagSpecs,
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "list", args.args),
    }),
    command("get", {
      summary: "Show one contact",
      args: contactTargetArgs,
      flags: { ...bookFlag, ...contactFlag },
      run: ({ ctx, args }) => runContactsCommand(ctx, "get", args.args),
    }),
    command("search", {
      summary: "Search contacts across books",
      args: {
        query: arg.rest({ valueLabel: "query", description: "Search query" }),
      },
      flags: {
        q: flag.string({ aliases: ["query"], description: "Search query" }),
        ...paginationFlagSpecs,
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "search", args.query),
    }),
    command("create", {
      summary: "Create a contact",
      args: bookArg,
      flags: {
        ...bookFlag,
        ...contactFieldFlags,
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "create", args.args),
    }),
    command("update", {
      summary: "Update a contact",
      args: contactTargetArgs,
      flags: {
        ...bookFlag,
        ...contactFlag,
        ...contactFieldFlags,
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "update", args.args),
    }),
    command("delete", {
      summary: "Delete a contact",
      args: contactTargetArgs,
      flags: { ...bookFlag, ...contactFlag },
      run: ({ ctx, args }) => runContactsCommand(ctx, "delete", args.args),
    }),
    command("move", {
      summary: "Move a contact to another book",
      args: contactTargetArgs,
      flags: {
        ...bookFlag,
        ...contactFlag,
        targetBook: flag.string({
          name: "target-book",
          aliases: ["targetBookId"],
          required: true,
          description: "Target book id or exact name",
        }),
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "move", args.args),
    }),
    command("tree", {
      summary: "Show a contact hierarchy tree",
      args: contactTargetArgs,
      flags: { ...bookFlag, ...contactFlag },
      run: ({ ctx, args }) => runContactsCommand(ctx, "tree", args.args),
    }),
    command("notes", {
      summary: "List contact notes",
      args: contactTargetArgs,
      flags: { ...bookFlag, ...contactFlag },
      run: ({ ctx, args }) => runContactsCommand(ctx, "notes", args.args),
    }),
    command("note", {
      summary: "Create a contact note",
      args: contactTargetArgs,
      flags: { ...bookFlag, ...contactFlag, ...contentFlagSpecs },
      run: ({ ctx, args }) => runContactsCommand(ctx, "note", args.args),
    }),
    command("update-note", {
      summary: "Update a contact note",
      args: contactTargetArgs,
      flags: { ...bookFlag, ...contactFlag, ...contentFlagSpecs },
      run: ({ ctx, args }) => runContactsCommand(ctx, "update-note", args.args),
    }),
    command("delete-note", {
      summary: "Delete a contact note",
      args: contactTargetArgs,
      flags: { ...bookFlag, ...contactFlag },
      run: ({ ctx, args }) => runContactsCommand(ctx, "delete-note", args.args),
    }),
    command("tags", {
      summary: "List contact tags",
      args: bookArg,
      flags: bookFlag,
      run: ({ ctx, args }) => runContactsCommand(ctx, "tags", args.args),
    }),
    command("create-tag", {
      summary: "Create a contact tag",
      args: bookArg,
      flags: {
        ...bookFlag,
        color: flag.string({ required: true, description: "Tag color" }),
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "create-tag", args.args),
    }),
    command("update-tag", {
      summary: "Update a contact tag",
      args: bookArg,
      flags: {
        ...bookFlag,
        name: flag.string({ description: "Tag name" }),
        color: flag.string({ description: "Tag color" }),
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "update-tag", args.args),
    }),
    command("delete-tag", {
      summary: "Delete a contact tag",
      args: bookArg,
      flags: bookFlag,
      run: ({ ctx, args }) => runContactsCommand(ctx, "delete-tag", args.args),
    }),
    command("export", {
      summary: "Export contacts",
      args: bookArg,
      flags: {
        ...bookFlag,
        format: flag.enum(["vcf", "csv"], { default: "vcf", description: "Export format" }),
        out: flag.string({ aliases: ["output"], description: "Write export to file" }),
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "export", args.args),
    }),
    command("import-preview", {
      summary: "Preview contact import",
      args: bookArg,
      flags: {
        ...bookFlag,
        file: flag.string({ aliases: ["f"], description: "Read import content from file" }),
        stdin: flag.boolean({ description: "Read import content from stdin" }),
      },
      run: ({ ctx, args }) => runContactsCommand(ctx, "import-preview", args.args),
    }),
  ],
});
