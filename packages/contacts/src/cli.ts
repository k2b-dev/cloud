import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  arg,
  type CloudCliContext,
  type CloudCliText,
  command,
  confirmFlag,
  createAccessCommands,
  defineCliCommands,
  flag,
  localizeCloudCliText,
  parseCliAddress,
  printRows,
  printStructured,
} from "@k2b/cloud/cli";
import type { AccessEntry, PermissionLevel, Principal } from "@k2b/cloud/contracts";
import type { Contact, ContactBook, ContactNote, ContactTag } from "./service/types";
import { resolveContactName } from "./shared";

type Page<T> = { data: T[]; pagination: { page: number; per_page: number; total: number; total_pages: number; has_next: boolean } };

/** `GET /api/contacts/resolve`: one book, and the contact when one was addressed. */
type Resolved = { book: ContactBook; contact: Contact | null };

type ImportCandidate = { candidate: Record<string, unknown>; match: { existingId: string; existingName: string } | null };

type ContactTreeNode = {
  id: string;
  label?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  jobTitle?: string | null;
  children?: ContactTreeNode[];
};

type ContactTree = { root: ContactTreeNode; selectedId: string };

const RESOURCE_ID = /^[0-9A-Za-z]{6}$/;
const JSON_HEADERS = { "Content-Type": "application/json" };

const api = (path: string) => `/api/contacts${path}`;
const bookApi = (bookId: string, suffix = "") => api(`/books/${encodeURIComponent(bookId)}${suffix}`);
const contactApi = (contact: Pick<Contact, "id" | "bookId">, suffix = "") =>
  bookApi(contact.bookId, `/contacts/${encodeURIComponent(contact.id)}${suffix}`);

const expandHome = (path: string): string => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

const withQuery = (path: string, query: Record<string, string | number | readonly string[] | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else params.set(key, String(value));
  }
  const rendered = params.toString();
  return rendered ? `${path}?${rendered}` : path;
};

const parsePair = (value: string, key: "email" | "phone") => {
  const equals = value.indexOf("=");
  return equals === -1 ? { [key]: value } : { label: value.slice(0, equals) || null, [key]: value.slice(equals + 1) };
};

const contactRow = (contact: Contact) => ({
  id: contact.id,
  bookId: contact.bookId,
  name: resolveContactName(contact),
  email: contact.emails[0]?.email ?? "",
  phone: contact.phones[0]?.phone ?? "",
  company: contact.companyName ?? "",
  updatedAt: contact.updatedAt,
});

const treeNodeName = (node: ContactTreeNode): string =>
  node.label || [node.firstName, node.lastName].filter(Boolean).join(" ") || node.companyName || node.id;

function contactsCommands(locale?: string) {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);
  const say = (en: string, de: string) => t({ en, de });

  // ==========================
  // Input and confirmation
  // ==========================

  const readFrom = async (from: string): Promise<string> => (from === "-" ? Bun.stdin.text() : readFile(expandHome(from), "utf8"));

  const readContent = async (from: string | undefined, content: string | undefined): Promise<string> => {
    if (from !== undefined && content !== undefined)
      throw new Error(t({ en: "Pass only one of --from or --content.", de: "Übergib nur --from oder --content." }));
    if (content !== undefined) return content;
    if (from !== undefined) return readFrom(from);
    throw new Error(
      t({
        en: "Missing content. Pass --from <file|-> or --content <text>.",
        de: "Inhalt fehlt. Übergib --from <datei|-> oder --content <text>.",
      }),
    );
  };

  /** Fail before any request when nobody can answer the confirmation prompt. */
  const requireConfirmable = (yes: boolean): void => {
    if (!yes && !process.stdin.isTTY)
      throw new Error(t({ en: "Refusing without confirmation. Pass --yes.", de: "Abgebrochen ohne Bestätigung. Übergib --yes." }));
  };

  const confirm = async (yes: boolean, question: string): Promise<void> => {
    requireConfirmable(yes);
    if (yes) return;
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await prompt.question(`${question} [y/N] `);
    prompt.close();
    if (!/^(?:y|yes|j|ja)$/i.test(answer.trim())) throw new Error(t({ en: "Cancelled.", de: "Abgebrochen." }));
  };

  // ==========================
  // Addressing
  // ==========================

  const resolve = async (ctx: CloudCliContext, query: { book?: string; contact?: string; email?: string }): Promise<Resolved> =>
    ctx.readJson<Resolved>(await ctx.fetch(withQuery(api("/resolve"), query)));

  const notLocal = (raw: string, what: CloudCliText): void => {
    if (parseCliAddress(raw).kind === "local")
      throw new Error(t({ en: `"${raw}" is a local path, not ${what.en}.`, de: `„${raw}“ ist ein lokaler Pfad, kein ${what.de}.` }));
  };

  /** A book: its ID or exact name, optionally followed by an empty `:`. */
  const resolveBook = async (ctx: CloudCliContext, raw: string): Promise<ContactBook> => {
    notLocal(raw, { en: "a contact book", de: "Kontaktbuch" });
    const address = parseCliAddress(raw);
    if (address.kind === "path" && address.path !== "")
      throw new Error(
        t({
          en: `"${raw}" names a contact, not a contact book. Pass the book ID or exact name.`,
          de: `„${raw}“ bezeichnet einen Kontakt, kein Kontaktbuch. Übergib die ID oder den exakten Namen des Kontaktbuchs.`,
        }),
      );
    return (await resolve(ctx, { book: address.kind === "path" ? address.container : raw })).book;
  };

  /** A contact: its ID, or `<book>:<name>` with the book as ID or exact name. */
  const resolveContact = async (ctx: CloudCliContext, raw: string): Promise<Resolved & { contact: Contact }> => {
    notLocal(raw, { en: "a contact", de: "Kontakt" });
    const address = parseCliAddress(raw);
    if (address.kind === "path" && address.path === "")
      throw new Error(
        t({
          en: `"${raw}" is a contact book, not a contact. Use a contact ID or <book>:<name>.`,
          de: `„${raw}“ ist ein Kontaktbuch, kein Kontakt. Verwende eine Kontakt-ID oder <buch>:<name>.`,
        }),
      );
    const resolved =
      address.kind === "path"
        ? await resolve(ctx, { book: address.container, contact: address.path })
        : await resolve(ctx, { contact: raw });
    if (!resolved.contact) throw new Error(t({ en: `No contact matches "${raw}".`, de: `Kein Kontakt passt zu „${raw}“.` }));
    return { book: resolved.book, contact: resolved.contact };
  };

  /** `<book>` or `<book>:` resolves the book; `<book>:<name>` or an ID resolves a contact. */
  const resolveTarget = async (ctx: CloudCliContext, raw: string): Promise<Resolved> => {
    const address = parseCliAddress(raw);
    if (address.kind === "path" && address.path === "") return { book: await resolveBook(ctx, raw), contact: null };
    return resolveContact(ctx, raw);
  };

  /** A tag as `<book>:<tag>`, the tag by ID or exact name. */
  const resolveTag = async (ctx: CloudCliContext, raw: string): Promise<{ book: ContactBook; tag: ContactTag }> => {
    const address = parseCliAddress(raw);
    if (address.kind !== "path" || !address.path)
      throw new Error(t({ en: `Address the tag as <book>:<tag>, not "${raw}".`, de: `Gib das Tag als <buch>:<tag> an, nicht „${raw}“.` }));
    const book = await resolveBook(ctx, address.container);
    const [tag] = await findTags(ctx, book, [address.path]);
    return { book, tag: tag! };
  };

  const findTags = async (ctx: CloudCliContext, book: ContactBook, refs: string[]): Promise<ContactTag[]> => {
    if (refs.length === 0) return [];
    const tags = await ctx.readJson<ContactTag[]>(await ctx.fetch(bookApi(book.id, "/tags")));
    return refs.map((ref) => {
      const tag = tags.find((item) => item.id === ref) ?? tags.find((item) => item.name === ref);
      if (!tag)
        throw new Error(
          t({
            en: `No tag in ${book.name} has the ID or exact name "${ref}".`,
            de: `Kein Tag in ${book.name} hat die ID oder den exakten Namen „${ref}“.`,
          }),
        );
      return tag;
    });
  };

  // ==========================
  // Contact fields
  // ==========================

  const fieldFlags = {
    label: flag.string({ description: t({ en: "Display name", de: "Anzeigename" }) }),
    firstName: flag.string({ name: "first-name", description: t({ en: "First name", de: "Vorname" }) }),
    lastName: flag.string({ name: "last-name", description: t({ en: "Last name", de: "Nachname" }) }),
    companyName: flag.string({ name: "company-name", description: t({ en: "Company name", de: "Firmenname" }) }),
    department: flag.string({ description: t({ en: "Department", de: "Abteilung" }) }),
    jobTitle: flag.string({ name: "job-title", description: t({ en: "Job title", de: "Position" }) }),
    vatId: flag.string({ name: "vat-id", description: t({ en: "VAT ID", de: "USt-IdNr." }) }),
    birthday: flag.string({ valueLabel: "YYYY-MM-DD", description: t({ en: "Birthday", de: "Geburtstag" }) }),
    salutation: flag.string({ description: t({ en: "Salutation", de: "Anrede" }) }),
    pronouns: flag.string({ description: t({ en: "Pronouns", de: "Pronomen" }) }),
    preferredLanguage: flag.string({
      name: "preferred-language",
      description: t({ en: "Preferred language tag", de: "Bevorzugtes Sprachkürzel" }),
    }),
    source: flag.string({ description: t({ en: "Source", de: "Quelle" }) }),
    email: flag.stringList({
      valueLabel: "[label=]email",
      description: t({ en: "Email address; replaces all. Repeatable.", de: "E-Mail-Adresse; ersetzt alle. Wiederholbar." }),
    }),
    phone: flag.stringList({
      valueLabel: "[label=]phone",
      description: t({ en: "Phone number; replaces all. Repeatable.", de: "Telefonnummer; ersetzt alle. Wiederholbar." }),
    }),
    tag: flag.stringList({
      description: t({
        en: "Tag ID or exact name; replaces all. Repeatable.",
        de: "Tag-ID oder exakter Name; ersetzt alle. Wiederholbar.",
      }),
    }),
    parent: flag.string({
      description: t({
        en: 'Parent contact in the same book, or "none" to clear',
        de: 'Übergeordneter Kontakt im selben Buch, oder "none" zum Entfernen',
      }),
    }),
    from: flag.string({
      valueLabel: "file|-",
      description: t({
        en: "Read contact fields as API JSON from a file, or - for stdin; flags win",
        de: "Kontaktfelder als API-JSON aus einer Datei lesen, - für stdin; Flags haben Vorrang",
      }),
    }),
  };

  type FieldFlags = {
    label?: string;
    firstName?: string;
    lastName?: string;
    companyName?: string;
    department?: string;
    jobTitle?: string;
    vatId?: string;
    birthday?: string;
    salutation?: string;
    pronouns?: string;
    preferredLanguage?: string;
    source?: string;
    email: string[];
    phone: string[];
    tag: string[];
    parent?: string;
    from?: string;
  };

  const contactPayload = async (ctx: CloudCliContext, book: ContactBook, flags: FieldFlags): Promise<Record<string, unknown>> => {
    const payload: Record<string, unknown> = flags.from ? JSON.parse(await readFrom(flags.from)) : {};
    if (typeof payload !== "object" || payload === null || Array.isArray(payload))
      throw new Error(t({ en: "--from must contain one JSON object.", de: "--from muss genau ein JSON-Objekt enthalten." }));
    const scalars = [
      "label",
      "firstName",
      "lastName",
      "companyName",
      "department",
      "jobTitle",
      "vatId",
      "birthday",
      "salutation",
      "pronouns",
      "preferredLanguage",
      "source",
    ] as const;
    for (const key of scalars) if (flags[key] !== undefined) payload[key] = flags[key];
    if (flags.email.length > 0) payload.emails = flags.email.map((value) => parsePair(value, "email"));
    if (flags.phone.length > 0) payload.phones = flags.phone.map((value) => parsePair(value, "phone"));
    if (flags.tag.length > 0) payload.tagIds = [...new Set((await findTags(ctx, book, flags.tag)).map((tag) => tag.id))];
    if (flags.parent !== undefined) {
      if (flags.parent === "none") payload.parentContactId = null;
      else {
        const parent = await resolveContact(ctx, flags.parent);
        if (parent.book.id !== book.id)
          throw new Error(
            t({ en: "The parent must be a contact in the same book.", de: "Der übergeordnete Kontakt muss im selben Buch liegen." }),
          );
        payload.parentContactId = parent.contact.id;
      }
    }
    if (Object.keys(payload).length === 0) throw new Error(t({ en: "No contact fields given.", de: "Keine Kontaktfelder angegeben." }));
    return payload;
  };

  // ==========================
  // Output
  // ==========================

  const printContact = (ctx: CloudCliContext, contact: Contact) => {
    if (printStructured(ctx, contact)) return;
    ctx.print(`${resolveContactName(contact)} (${contact.id})`);
    const role = [contact.jobTitle, contact.companyName].filter(Boolean).join(", ");
    if (role) ctx.print(role);
    if (contact.emails.length > 0) ctx.print(`email: ${contact.emails.map((item) => item.email).join(", ")}`);
    if (contact.phones.length > 0) ctx.print(`phone: ${contact.phones.map((item) => item.phone).join(", ")}`);
    if (contact.tags.length > 0) ctx.print(`tags: ${contact.tags.map((tag) => tag.name).join(", ")}`);
  };

  const contactColumns = [
    { key: "id", label: "ID" },
    { key: "name", label: "NAME" },
    { key: "email", label: t({ en: "EMAIL", de: "E-MAIL" }) },
    { key: "phone", label: t({ en: "PHONE", de: "TELEFON" }) },
    { key: "company", label: t({ en: "COMPANY", de: "FIRMA" }) },
  ];

  // ==========================
  // Commands
  // ==========================

  const pageFlags = {
    page: flag.int({ min: 1, description: t({ en: "Page number", de: "Seitennummer" }) }),
    perPage: flag.int({ name: "per-page", min: 1, max: 100, description: t({ en: "Items per page", de: "Einträge pro Seite" }) }),
  };
  const contactArg = {
    contact: arg.required({
      valueLabel: "contact",
      description: t({ en: "Contact ID or <book>:<name>", de: "Kontakt-ID oder <buch>:<name>" }),
    }),
  };
  const bookArg = {
    book: arg.required({
      valueLabel: "book",
      description: t({ en: "Contact book ID or exact name", de: "Kontaktbuch-ID oder exakter Name" }),
    }),
  };
  const tagArg = {
    tag: arg.required({
      valueLabel: "book:tag",
      description: t({ en: "<book>:<tag>, the tag by ID or exact name", de: "<buch>:<tag>, das Tag per ID oder exaktem Namen" }),
    }),
  };
  const noteArgs = {
    ...contactArg,
    note: arg.required({ valueLabel: "note-id", description: t({ en: "Note ID", de: "Notiz-ID" }) }),
  };
  const contentFlags = {
    from: flag.string({
      valueLabel: "file|-",
      description: t({ en: "Read the text from a file, or - for stdin", de: "Text aus einer Datei lesen, - für stdin" }),
    }),
    content: flag.string({ description: t({ en: "Text given inline", de: "Text direkt angeben" }) }),
  };
  const yesFlag = (en: string, de: string) => ({ yes: confirmFlag(t({ en, de })) });

  const accessCommands = createAccessCommands({
    resourceLabel: "contact book",
    resourceArgLabel: "book",
    resourceArgDescription: "Contact book ID or exact name.",
    resolveResource: async (ctx, args) => {
      if (!args[0]) throw new Error(t({ en: "Missing contact book.", de: "Kontaktbuch fehlt." }));
      const book = await resolveBook(ctx, args[0]);
      return { id: book.id, label: `${book.name} (${book.id})` };
    },
    list: async (ctx, book) => ctx.readJson<AccessEntry[]>(await ctx.fetch(bookApi(book.id, "/access"))),
    grant: async (ctx, book, principal: Principal, permission: PermissionLevel) =>
      ctx.readJson<AccessEntry>(
        await ctx.fetch(bookApi(book.id, "/access"), {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ principal, permission }),
        }),
      ),
    update: async (ctx, book, accessId, permission) => {
      await ctx.readJson<unknown>(
        await ctx.fetch(bookApi(book.id, `/access/${encodeURIComponent(accessId)}`), {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ permission }),
        }),
      );
    },
    revoke: async (ctx, book, accessId) => {
      await ctx.readJson<unknown>(await ctx.fetch(bookApi(book.id, `/access/${encodeURIComponent(accessId)}`), { method: "DELETE" }));
    },
    examples: {
      list: ['cld contacts access list "Customers"', "cld contacts access list Ab12Cd --include-service-accounts"],
      grant: [
        'cld contacts access grant "Customers" --user valentin.kolb --permission read',
        'cld contacts access grant "Customers" --group "Editors" --permission write',
      ],
      set: ['cld contacts access set "Customers" --user valentin.kolb --permission admin'],
      revoke: ['cld contacts access revoke "Customers" --user valentin.kolb --yes'],
      searchPrincipals: ["cld contacts access search-principals val --kind user,group"],
    },
  });

  return defineCliCommands({
    name: "contacts",
    summary: t({
      en: "Find and change contacts by ID or <book>:<name>, and manage contact books.",
      de: "Kontakte per ID oder <buch>:<name> finden und ändern und Kontaktbücher verwalten.",
    }),
    groupSummaries: {
      books: t({ en: "Create, rename, and delete contact books", de: "Kontaktbücher anlegen, umbenennen und löschen" }),
      tags: t({ en: "Manage the tags of a contact book", de: "Die Tags eines Kontaktbuchs verwalten" }),
      notes: t({ en: "Keep notes on a contact", de: "Notizen zu einem Kontakt führen" }),
      access: t({ en: "Manage direct access to contact books", de: "Direkten Zugriff auf Kontaktbücher verwalten" }),
    },
    commands: [
      // ---------- Contacts ----------
      command("ls", {
        summary: t({ en: "List contact books, or the contacts of one book", de: "Kontaktbücher oder die Kontakte eines Buchs auflisten" }),
        args: {
          book: arg.optional({
            valueLabel: "book",
            description: t({ en: "Contact book ID or exact name", de: "Kontaktbuch-ID oder exakter Name" }),
          }),
        },
        flags: {
          q: flag.string({ description: t({ en: "Filter by text", de: "Nach Text filtern" }) }),
          tag: flag.stringList({
            description: t({
              en: "Only contacts with this tag ID or name. Repeatable.",
              de: "Nur Kontakte mit diesem Tag (ID oder Name). Wiederholbar.",
            }),
          }),
          ...pageFlags,
        },
        examples: ["cld contacts ls", 'cld contacts ls "Customers" --q ada --tag VIP'],
        async run({ ctx, args, flags }) {
          if (!args.book) {
            if (flags.tag.length > 0) throw new Error(t({ en: "--tag needs a contact book.", de: "--tag braucht ein Kontaktbuch." }));
            const payload = await ctx.readJson<Page<ContactBook>>(
              await ctx.fetch(withQuery(api("/books"), { q: flags.q, page: flags.page, per_page: flags.perPage })),
            );
            printRows(ctx, payload, payload.data, [
              { key: "id", label: "ID" },
              { key: "name", label: "NAME" },
              { key: "updatedAt", label: t({ en: "UPDATED", de: "GEÄNDERT" }) },
            ]);
            return;
          }
          const book = await resolveBook(ctx, args.book);
          const tags = await findTags(ctx, book, flags.tag);
          const page = await ctx.readJson<Page<Contact>>(
            await ctx.fetch(
              withQuery(bookApi(book.id, "/contacts"), {
                q: flags.q,
                tag_id: tags.map((tag) => tag.id),
                page: flags.page,
                per_page: flags.perPage,
              }),
            ),
          );
          printRows(
            ctx,
            { book: { id: book.id, name: book.name }, data: page.data, pagination: page.pagination },
            page.data.map(contactRow),
            contactColumns,
          );
        },
      }),
      command("show", {
        summary: t({ en: "Show a contact, or a contact book as <book>:", de: "Einen Kontakt zeigen, oder ein Kontaktbuch als <buch>:" }),
        args: {
          contact: arg.optional({
            valueLabel: "contact",
            description: t({ en: "Contact ID, <book>:<name>, or <book>:", de: "Kontakt-ID, <buch>:<name> oder <buch>:" }),
          }),
        },
        flags: {
          email: flag.string({
            description: t({
              en: "Find the one contact with this email address",
              de: "Den einen Kontakt mit dieser E-Mail-Adresse finden",
            }),
          }),
        },
        examples: [
          "cld contacts show Ab12Cd",
          'cld contacts show "Customers:Ada Lovelace"',
          "cld contacts show --email ada@example.org --json",
        ],
        async run({ ctx, args, flags }) {
          if ((args.contact === undefined) === (flags.email === undefined))
            throw new Error(t({ en: "Pass either a contact or --email.", de: "Übergib entweder einen Kontakt oder --email." }));
          if (flags.email !== undefined) {
            const { contact } = await resolve(ctx, { email: flags.email });
            printContact(ctx, contact!);
            return;
          }
          const target = await resolveTarget(ctx, args.contact!);
          if (target.contact) return printContact(ctx, target.contact);
          if (!printStructured(ctx, target.book)) {
            ctx.print(`${target.book.name} (${target.book.id})`);
            if (target.book.description) ctx.print(target.book.description);
          }
        },
      }),
      command("search", {
        summary: t({ en: "Search contacts across all readable books", de: "Kontakte in allen lesbaren Büchern suchen" }),
        args: { query: arg.rest({ valueLabel: "query", required: true, description: t({ en: "Search text", de: "Suchtext" }) }) },
        flags: pageFlags,
        examples: ['cld contacts search "Ada Lovelace" --json'],
        async run({ ctx, args, flags }) {
          const payload = await ctx.readJson<Page<Contact>>(
            await ctx.fetch(withQuery(api("/search"), { q: args.query.join(" "), page: flags.page, per_page: flags.perPage })),
          );
          printRows(ctx, { data: payload.data, pagination: payload.pagination }, payload.data.map(contactRow), contactColumns);
        },
      }),
      command("add", {
        summary: t({ en: "Create a contact", de: "Einen Kontakt anlegen" }),
        description: t({
          en: "The name after the colon becomes the display name (label). Emails, phones, and tags are repeatable.",
          de: "Der Name nach dem Doppelpunkt wird zum Anzeigenamen (Label). E-Mails, Telefonnummern und Tags sind wiederholbar.",
        }),
        args: {
          target: arg.required({
            valueLabel: "book[:name]",
            description: t({ en: "Contact book, optionally with the display name", de: "Kontaktbuch, optional mit Anzeigenamen" }),
          }),
        },
        flags: fieldFlags,
        examples: [
          'cld contacts add "Customers:Ada Lovelace" --email work=ada@example.org --tag VIP',
          "cld contacts add Customers --first-name Ada --last-name Lovelace",
          "cld contacts add Customers --from ada.json",
        ],
        async run({ ctx, args, flags }) {
          notLocal(args.target, { en: "a contact book", de: "Kontaktbuch" });
          const address = parseCliAddress(args.target);
          const book = await resolveBook(ctx, address.kind === "path" ? address.container : args.target);
          const payload = await contactPayload(ctx, book, {
            ...flags,
            label: flags.label ?? (address.kind === "path" && address.path ? address.path : undefined),
          });
          const contact = await ctx.readJson<Contact>(
            await ctx.fetch(bookApi(book.id, "/contacts"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) }),
          );
          if (!printStructured(ctx, contact))
            ctx.print(`${say("Created", "Angelegt")} ${resolveContactName(contact)} (${contact.id}) in ${book.name}`);
        },
      }),
      command("set", {
        summary: t({ en: "Change contact fields", de: "Kontaktfelder ändern" }),
        args: contactArg,
        flags: fieldFlags,
        examples: ['cld contacts set "Customers:Ada Lovelace" --job-title Mathematician', "cld contacts set Ab12Cd --parent none"],
        async run({ ctx, args, flags }) {
          const { book, contact } = await resolveContact(ctx, args.contact);
          const payload = await contactPayload(ctx, book, flags);
          const updated = await ctx.readJson<Contact>(
            await ctx.fetch(contactApi(contact), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(payload) }),
          );
          if (!printStructured(ctx, updated)) ctx.print(`${say("Updated", "Aktualisiert")} ${resolveContactName(updated)} (${updated.id})`);
        },
      }),
      command("mv", {
        summary: t({ en: "Move a contact to another book", de: "Einen Kontakt in ein anderes Buch verschieben" }),
        description: t({
          en: "Tags and hierarchy links do not cross books and are removed.",
          de: "Tags und Hierarchie-Verknüpfungen gelten nicht über Bücher hinweg und werden entfernt.",
        }),
        args: {
          ...contactArg,
          book: arg.required({ valueLabel: "book", description: t({ en: "Target contact book", de: "Ziel-Kontaktbuch" }) }),
        },
        examples: ['cld contacts mv "Customers:Ada Lovelace" Alumni'],
        async run({ ctx, args }) {
          const { contact } = await resolveContact(ctx, args.contact);
          const target = await resolveBook(ctx, args.book);
          const moved = await ctx.readJson<Contact>(
            await ctx.fetch(contactApi(contact, "/move"), {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({ targetBookId: target.id }),
            }),
          );
          if (!printStructured(ctx, moved))
            ctx.print(`${say("Moved", "Verschoben")} ${resolveContactName(moved)} (${moved.id}) → ${target.name}`);
        },
      }),
      command("rm", {
        summary: t({ en: "Delete a contact", de: "Einen Kontakt löschen" }),
        args: contactArg,
        flags: yesFlag("Delete without asking", "Ohne Nachfrage löschen"),
        async run({ ctx, args, flags }) {
          requireConfirmable(flags.yes);
          const { contact } = await resolveContact(ctx, args.contact);
          const name = resolveContactName(contact);
          await confirm(flags.yes, say(`Delete "${name}" (${contact.id})?`, `„${name}“ (${contact.id}) löschen?`));
          await ctx.readJson<unknown>(await ctx.fetch(contactApi(contact), { method: "DELETE" }));
          if (!printStructured(ctx, { deleted: { id: contact.id, bookId: contact.bookId, name } }))
            ctx.print(`${say("Deleted", "Gelöscht")} ${name} (${contact.id})`);
        },
      }),
      command("tree", {
        summary: t({ en: "Show the hierarchy around a contact", de: "Die Hierarchie um einen Kontakt zeigen" }),
        args: contactArg,
        async run({ ctx, args }) {
          const { contact } = await resolveContact(ctx, args.contact);
          const tree = await ctx.readJson<ContactTree>(await ctx.fetch(contactApi(contact, "/tree")));
          if (printStructured(ctx, tree)) return;
          const visit = (node: ContactTreeNode, depth: number) => {
            const role = node.jobTitle ? ` – ${node.jobTitle}` : "";
            ctx.print(`${"  ".repeat(depth)}${node.id === tree.selectedId ? "*" : "-"} ${treeNodeName(node)}${role} (${node.id})`);
            for (const child of node.children ?? []) visit(child, depth + 1);
          };
          visit(tree.root, 0);
        },
      }),
      command("export", {
        summary: t({ en: "Export a contact book as vCard or CSV", de: "Ein Kontaktbuch als vCard oder CSV exportieren" }),
        args: bookArg,
        flags: {
          format: flag.enum(["vcf", "csv"], { default: "vcf", description: t({ en: "File format", de: "Dateiformat" }) }),
          out: flag.string({
            description: t({ en: "Write to this file instead of stdout", de: "In diese Datei statt auf stdout schreiben" }),
          }),
        },
        examples: ['cld contacts export "Customers" --format csv --out customers.csv'],
        async run({ ctx, args, flags }) {
          const book = await resolveBook(ctx, args.book);
          const format = flags.format ?? "vcf";
          const response = await ctx.fetch(bookApi(book.id, `/export.${format}`));
          if (!response.ok) await ctx.readJson<unknown>(response);
          const body = await response.text();
          if (!flags.out) {
            await ctx.write(body);
            return;
          }
          const output = expandHome(flags.out);
          await writeFile(output, body);
          if (!printStructured(ctx, { book: { id: book.id, name: book.name }, format, output }))
            ctx.print(`${say("Exported to", "Exportiert nach")} ${output}`);
        },
      }),
      command("import", {
        summary: t({ en: "Import contacts from a vCard file", de: "Kontakte aus einer vCard-Datei importieren" }),
        description: t({
          en: "Contacts that match an existing contact by email or full name are skipped unless --include-duplicates is given. --dry-run only shows the preview. Exits 1 when any contact fails.",
          de: "Kontakte, die per E-Mail oder vollem Namen zu einem vorhandenen Kontakt passen, werden übersprungen, außer mit --include-duplicates. --dry-run zeigt nur die Vorschau. Endet mit 1, wenn ein Kontakt fehlschlägt.",
        }),
        args: bookArg,
        flags: {
          from: flag.string({
            valueLabel: "file|-",
            required: true,
            description: t({ en: "vCard file, or - for stdin", de: "vCard-Datei, - für stdin" }),
          }),
          dryRun: flag.boolean({
            name: "dry-run",
            description: t({ en: "Preview without creating contacts", de: "Vorschau ohne Kontakte anzulegen" }),
          }),
          includeDuplicates: flag.boolean({
            name: "include-duplicates",
            description: t({
              en: "Also import contacts that match existing ones",
              de: "Auch Kontakte importieren, die zu vorhandenen passen",
            }),
          }),
        },
        examples: ['cld contacts import "Customers" --from contacts.vcf --dry-run', 'cld contacts import "Customers" --from contacts.vcf'],
        async run({ ctx, args, flags }) {
          const book = await resolveBook(ctx, args.book);
          const content = await readFrom(flags.from!);
          const preview = await ctx.readJson<{ candidates: ImportCandidate[] }>(
            await ctx.fetch(bookApi(book.id, "/import/preview"), {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({ format: "vcard", content }),
            }),
          );
          const selected = preview.candidates.filter((item) => flags.includeDuplicates || !item.match);
          const skipped = preview.candidates.length - selected.length;
          if (flags.dryRun) {
            if (printStructured(ctx, { book: { id: book.id, name: book.name }, candidates: preview.candidates })) return;
            for (const item of preview.candidates) {
              const name = resolveContactName(item.candidate as Parameters<typeof resolveContactName>[0]);
              ctx.print(
                item.match ? `= ${name} (${say("matches", "passt zu")} ${item.match.existingName} ${item.match.existingId})` : `+ ${name}`,
              );
            }
            ctx.print(
              say(`${selected.length} to import, ${skipped} skipped.`, `${selected.length} zu importieren, ${skipped} übersprungen.`),
            );
            return;
          }
          const result =
            selected.length === 0
              ? { created: 0, failures: [] as string[] }
              : await ctx.readJson<{ created: number; failures: string[] }>(
                  await ctx.fetch(bookApi(book.id, "/import/commit"), {
                    method: "POST",
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ contacts: selected.map((item) => item.candidate) }),
                  }),
                );
          if (
            !printStructured(ctx, { book: { id: book.id, name: book.name }, created: result.created, skipped, failures: result.failures })
          ) {
            ctx.print(
              say(
                `Imported ${result.created} into ${book.name}, ${skipped} skipped, ${result.failures.length} failed.`,
                `${result.created} in ${book.name} importiert, ${skipped} übersprungen, ${result.failures.length} fehlgeschlagen.`,
              ),
            );
            for (const failure of result.failures) ctx.error(failure);
          }
          return result.failures.length > 0 ? 1 : 0;
        },
      }),

      // ---------- Books ----------
      command("books add", {
        summary: t({ en: "Create a contact book", de: "Ein Kontaktbuch anlegen" }),
        args: { name: arg.required({ description: t({ en: "Book name", de: "Name des Buchs" }) }) },
        flags: { description: flag.string({ description: t({ en: "Description", de: "Beschreibung" }) }) },
        async run({ ctx, args, flags }) {
          const book = await ctx.readJson<ContactBook>(
            await ctx.fetch(api("/books"), {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({ name: args.name, ...(flags.description !== undefined ? { description: flags.description } : {}) }),
            }),
          );
          if (!printStructured(ctx, book)) ctx.print(`${say("Created", "Angelegt")} ${book.name} (${book.id})`);
        },
      }),
      command("books update", {
        summary: t({
          en: "Rename a contact book or change its description",
          de: "Ein Kontaktbuch umbenennen oder seine Beschreibung ändern",
        }),
        args: bookArg,
        flags: {
          name: flag.string({ description: t({ en: "New name", de: "Neuer Name" }) }),
          description: flag.string({ description: t({ en: "Description", de: "Beschreibung" }) }),
        },
        async run({ ctx, args, flags }) {
          const book = await resolveBook(ctx, args.book);
          const body: Record<string, string> = {};
          if (flags.name !== undefined) body.name = flags.name;
          if (flags.description !== undefined) body.description = flags.description;
          if (Object.keys(body).length === 0) throw new Error(t({ en: "Nothing to change.", de: "Nichts zu ändern." }));
          const updated = await ctx.readJson<ContactBook>(
            await ctx.fetch(bookApi(book.id), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) }),
          );
          if (!printStructured(ctx, updated)) ctx.print(`${say("Updated", "Aktualisiert")} ${updated.name} (${updated.id})`);
        },
      }),
      command("books delete", {
        summary: t({ en: "Delete a contact book with all its contacts", de: "Ein Kontaktbuch mit allen Kontakten löschen" }),
        args: bookArg,
        flags: yesFlag("Delete without asking", "Ohne Nachfrage löschen"),
        async run({ ctx, args, flags }) {
          requireConfirmable(flags.yes);
          const book = await resolveBook(ctx, args.book);
          await confirm(
            flags.yes,
            say(
              `Delete the book "${book.name}" (${book.id}) and all its contacts?`,
              `Das Buch „${book.name}“ (${book.id}) mit allen Kontakten löschen?`,
            ),
          );
          await ctx.readJson<unknown>(await ctx.fetch(bookApi(book.id), { method: "DELETE" }));
          if (!printStructured(ctx, { deleted: { id: book.id, name: book.name } }))
            ctx.print(`${say("Deleted", "Gelöscht")} ${book.name} (${book.id})`);
        },
      }),

      // ---------- Tags ----------
      command("tags list", {
        summary: t({ en: "List the tags of a contact book", de: "Die Tags eines Kontaktbuchs auflisten" }),
        args: bookArg,
        async run({ ctx, args }) {
          const book = await resolveBook(ctx, args.book);
          const tags = await ctx.readJson<ContactTag[]>(await ctx.fetch(bookApi(book.id, "/tags")));
          printRows(ctx, tags, tags, [
            { key: "id", label: "ID" },
            { key: "name", label: "NAME" },
            { key: "color", label: t({ en: "COLOR", de: "FARBE" }) },
          ]);
        },
      }),
      command("tags add", {
        summary: t({ en: "Create a tag", de: "Ein Tag anlegen" }),
        args: {
          tag: arg.required({ valueLabel: "book:name", description: t({ en: "<book>:<new tag name>", de: "<buch>:<neuer Tagname>" }) }),
        },
        flags: { color: flag.string({ required: true, valueLabel: "#RRGGBB", description: t({ en: "Tag color", de: "Tagfarbe" }) }) },
        examples: ['cld contacts tags add "Customers:Conference 2026" --color "#2563eb"'],
        async run({ ctx, args, flags }) {
          const address = parseCliAddress(args.tag);
          if (address.kind !== "path" || !address.path)
            throw new Error(
              t({ en: `Name the tag as <book>:<name>, not "${args.tag}".`, de: `Gib das Tag als <buch>:<name> an, nicht „${args.tag}“.` }),
            );
          const book = await resolveBook(ctx, address.container);
          const tag = await ctx.readJson<ContactTag>(
            await ctx.fetch(bookApi(book.id, "/tags"), {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({ name: address.path, color: flags.color }),
            }),
          );
          if (!printStructured(ctx, tag)) ctx.print(`${say("Created", "Angelegt")} ${tag.name} (${tag.id})`);
        },
      }),
      command("tags update", {
        summary: t({ en: "Rename or recolor a tag", de: "Ein Tag umbenennen oder umfärben" }),
        args: tagArg,
        flags: {
          name: flag.string({ description: t({ en: "New name", de: "Neuer Name" }) }),
          color: flag.string({ valueLabel: "#RRGGBB", description: t({ en: "Tag color", de: "Tagfarbe" }) }),
        },
        async run({ ctx, args, flags }) {
          const { book, tag } = await resolveTag(ctx, args.tag);
          const body: Record<string, string> = {};
          if (flags.name !== undefined) body.name = flags.name;
          if (flags.color !== undefined) body.color = flags.color;
          if (Object.keys(body).length === 0) throw new Error(t({ en: "Nothing to change.", de: "Nichts zu ändern." }));
          const updated = await ctx.readJson<ContactTag>(
            await ctx.fetch(bookApi(book.id, `/tags/${encodeURIComponent(tag.id)}`), {
              method: "PATCH",
              headers: JSON_HEADERS,
              body: JSON.stringify(body),
            }),
          );
          if (!printStructured(ctx, updated)) ctx.print(`${say("Updated", "Aktualisiert")} ${updated.name} (${updated.id})`);
        },
      }),
      command("tags delete", {
        summary: t({ en: "Delete a tag and remove it from all contacts", de: "Ein Tag löschen und von allen Kontakten entfernen" }),
        args: tagArg,
        flags: yesFlag("Delete without asking", "Ohne Nachfrage löschen"),
        async run({ ctx, args, flags }) {
          requireConfirmable(flags.yes);
          const { book, tag } = await resolveTag(ctx, args.tag);
          await confirm(flags.yes, say(`Delete the tag "${tag.name}" (${tag.id})?`, `Das Tag „${tag.name}“ (${tag.id}) löschen?`));
          await ctx.readJson<unknown>(await ctx.fetch(bookApi(book.id, `/tags/${encodeURIComponent(tag.id)}`), { method: "DELETE" }));
          if (!printStructured(ctx, { deleted: { id: tag.id, name: tag.name } }))
            ctx.print(`${say("Deleted", "Gelöscht")} ${tag.name} (${tag.id})`);
        },
      }),

      // ---------- Notes ----------
      command("notes list", {
        summary: t({ en: "List the notes on a contact", de: "Die Notizen zu einem Kontakt auflisten" }),
        args: contactArg,
        async run({ ctx, args }) {
          const { contact } = await resolveContact(ctx, args.contact);
          const notes = await ctx.readJson<ContactNote[]>(await ctx.fetch(contactApi(contact, "/notes")));
          printRows(
            ctx,
            notes,
            notes.map((note) => ({ ...note, content: note.content.replace(/\s+/g, " ").slice(0, 80) })),
            [
              { key: "id", label: "ID" },
              { key: "createdAt", label: t({ en: "CREATED", de: "ERSTELLT" }) },
              { key: "authorDisplayName", label: t({ en: "AUTHOR", de: "AUTOR" }) },
              { key: "content", label: t({ en: "CONTENT", de: "INHALT" }) },
            ],
          );
        },
      }),
      command("notes add", {
        summary: t({ en: "Add a note to a contact", de: "Eine Notiz zu einem Kontakt hinzufügen" }),
        args: contactArg,
        flags: contentFlags,
        examples: ['cld contacts notes add "Customers:Ada Lovelace" --content "Met at the archive."'],
        async run({ ctx, args, flags }) {
          const { contact } = await resolveContact(ctx, args.contact);
          const content = await readContent(flags.from, flags.content);
          const note = await ctx.readJson<ContactNote>(
            await ctx.fetch(contactApi(contact, "/notes"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ content }) }),
          );
          if (!printStructured(ctx, note)) ctx.print(`${say("Added note", "Notiz hinzugefügt")} ${note.id}`);
        },
      }),
      command("notes update", {
        summary: t({ en: "Replace the text of your recent note", de: "Den Text deiner neuen Notiz ersetzen" }),
        args: noteArgs,
        flags: contentFlags,
        async run({ ctx, args, flags }) {
          const noteId = requireNoteId(args.note);
          const { contact } = await resolveContact(ctx, args.contact);
          const content = await readContent(flags.from, flags.content);
          const note = await ctx.readJson<ContactNote>(
            await ctx.fetch(contactApi(contact, `/notes/${encodeURIComponent(noteId)}`), {
              method: "PATCH",
              headers: JSON_HEADERS,
              body: JSON.stringify({ content }),
            }),
          );
          if (!printStructured(ctx, note)) ctx.print(`${say("Updated note", "Notiz aktualisiert")} ${note.id}`);
        },
      }),
      command("notes delete", {
        summary: t({ en: "Delete your recent note", de: "Deine neue Notiz löschen" }),
        args: noteArgs,
        flags: yesFlag("Delete without asking", "Ohne Nachfrage löschen"),
        async run({ ctx, args, flags }) {
          requireConfirmable(flags.yes);
          const noteId = requireNoteId(args.note);
          const { contact } = await resolveContact(ctx, args.contact);
          await confirm(flags.yes, say(`Delete note ${noteId}?`, `Notiz ${noteId} löschen?`));
          await ctx.readJson<unknown>(await ctx.fetch(contactApi(contact, `/notes/${encodeURIComponent(noteId)}`), { method: "DELETE" }));
          if (!printStructured(ctx, { deleted: { id: noteId, contactId: contact.id } }))
            ctx.print(`${say("Deleted note", "Notiz gelöscht")} ${noteId}`);
        },
      }),

      ...accessCommands,
    ],
  });

  function requireNoteId(value: string): string {
    if (!RESOURCE_ID.test(value)) throw new Error(t({ en: `"${value}" is not a note ID.`, de: `„${value}“ ist keine Notiz-ID.` }));
    return value;
  }
}

const contacts = contactsCommands();

export default {
  ...contacts,
  help: (locale?: string) => contactsCommands(locale).help!(),
  run: (ctx: CloudCliContext) => contactsCommands(ctx.options.locale).run(ctx),
};
