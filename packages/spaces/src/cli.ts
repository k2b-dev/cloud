import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  arg,
  type CloudCliContext,
  type CloudCliText,
  cliAmbiguityText,
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
import type { Paginated } from "@k2b/stdlib";
import type {
  CalendarItem,
  ItemListResult,
  OverlapItem,
  Space,
  SpaceAssignableUser,
  SpaceComment,
  SpaceDetail,
  SpaceItem,
  SpaceItemAttachment,
  SpaceItemResourceReference,
  SpaceTaskChecklistEntry,
  SpaceTaskDependency,
  SpaceTaskDependent,
} from "./contracts";
import type { EventInvitationContext, EventInvitationDraft } from "./integration";
import type { TaskWork } from "./work-contracts";

const SHORT_ID = /^[0-9A-Za-z]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const JSON_HEADERS = { "Content-Type": "application/json" };

const api = (path = "") => `/api/spaces${path}`;
const itemApi = (item: Pick<SpaceItem, "id" | "spaceId">, suffix = "") =>
  api(`/${encodeURIComponent(item.spaceId)}/items/${encodeURIComponent(item.id)}${suffix}`);

const expandHome = (path: string): string => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

const isTask = (item: SpaceItem): boolean => !item.startsAt && !item.endsAt;

const withQuery = (path: string, query: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  const rendered = params.toString();
  return rendered ? `${path}?${rendered}` : path;
};

type ItemDeps = { item: { id: string; title: string }; blockers: SpaceTaskDependency[]; blocks: Paginated<SpaceTaskDependent> };

function spacesCommands(locale?: string) {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);

  // ==========================
  // Requests and input
  // ==========================

  const readApi = async <T>(ctx: CloudCliContext, path: string, init?: RequestInit): Promise<T> =>
    ctx.readJson<T>(await ctx.fetch(path, init));
  const send = <T>(ctx: CloudCliContext, method: string, path: string, body?: unknown): Promise<T> =>
    readApi<T>(ctx, path, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });

  /** `--<field> <text>` or `--from <file|->`; undefined when neither is given. */
  const readText = async (literal: string | undefined, from: string | undefined, field: string): Promise<string | undefined> => {
    if (literal !== undefined && from !== undefined)
      throw new Error(t({ en: `Pass only one of --${field} or --from.`, de: `Übergib nur --${field} oder --from.` }));
    if (literal !== undefined) return literal;
    if (from === "-") return Bun.stdin.text();
    if (from !== undefined) return readFile(expandHome(from), "utf8");
    return undefined;
  };

  const requireText = async (literal: string | undefined, from: string | undefined, field: string): Promise<string> => {
    const value = await readText(literal, from, field);
    if (value === undefined)
      throw new Error(
        t({
          en: `Missing ${field}. Pass --${field} <text> or --from <file|->.`,
          de: `${field} fehlt. Übergib --${field} <text> oder --from <datei|->.`,
        }),
      );
    return value;
  };

  const requireYes = (yes: boolean) => {
    if (!yes) throw new Error(t({ en: "Refusing without confirmation. Pass --yes.", de: "Abgebrochen ohne Bestätigung. Übergib --yes." }));
  };

  const dateTime = (value: string | undefined, label: string, endOfDay = false): string | undefined => {
    if (!value) return undefined;
    if (DATE_ONLY.test(value)) return `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new Error(
        t({
          en: `${label} must be an ISO datetime or a YYYY-MM-DD date.`,
          de: `${label} muss ein ISO-Zeitpunkt oder ein Datum YYYY-MM-DD sein.`,
        }),
      );
    return date.toISOString();
  };

  // ==========================
  // Addressing
  // ==========================

  const notAnItem = (raw: string) =>
    new Error(
      t({
        en: `"${raw}" is not an item address. Use an item ID or <space>:<title>.`,
        de: `„${raw}“ ist keine Eintragsadresse. Verwende eine Eintrags-ID oder <space>:<titel>.`,
      }),
    );

  /** A space: its ID or exact name, optionally followed by an empty `:`. */
  const resolveSpace = async (ctx: CloudCliContext, raw: string): Promise<Space> => {
    const address = parseCliAddress(raw);
    if (address.kind === "local" || (address.kind === "path" && address.path !== ""))
      throw new Error(
        t({
          en: `"${raw}" is not a space. Use a space ID or exact name.`,
          de: `„${raw}“ ist kein Space. Verwende eine Space-ID oder den exakten Namen.`,
        }),
      );
    const ref = address.kind === "path" ? address.container : address.ref;
    return (await readApi<{ space: Space }>(ctx, withQuery(api("/resolve"), { space: ref }))).space;
  };

  const loadSpace = (ctx: CloudCliContext, spaceId: string) => readApi<SpaceDetail>(ctx, api(`/${encodeURIComponent(spaceId)}`));

  /** An item: its ID, or `<space>:<title>` with the space by ID or exact name. */
  const resolveItem = async (ctx: CloudCliContext, raw: string): Promise<SpaceItem> => {
    const address = parseCliAddress(raw);
    if (address.kind === "ref") {
      if (!SHORT_ID.test(address.ref)) throw notAnItem(raw);
      return readApi<SpaceItem>(ctx, api(`/items/${encodeURIComponent(address.ref)}`));
    }
    if (address.kind === "local" || address.path === "") throw notAnItem(raw);
    const { item } = await readApi<{ item: SpaceItem }>(ctx, withQuery(api("/resolve"), { space: address.container, title: address.path }));
    return item;
  };

  const resolveColumnId = (space: SpaceDetail, ref: string): string => {
    const matches = space.columns.filter((column) => column.id === ref || column.name === ref);
    if (matches.length === 1) return matches[0]!.id;
    const list = space.columns.map((column) => `${column.name} (${column.id})`).join(", ");
    throw new Error(
      matches.length > 1
        ? t({
            en: `Column "${ref}" is ambiguous in ${space.name}. Use one of: ${list}`,
            de: `Die Spalte „${ref}“ ist in ${space.name} mehrdeutig. Verwende eine von: ${list}`,
          })
        : t({
            en: `Column "${ref}" was not found in ${space.name}. Columns: ${list}`,
            de: `Die Spalte „${ref}“ gibt es in ${space.name} nicht. Spalten: ${list}`,
          }),
    );
  };

  const resolveTagIds = (space: SpaceDetail, refs: string[]): string[] =>
    refs.map((ref) => {
      const matches = space.tags.filter((tag) => tag.id === ref || tag.name === ref);
      if (matches.length === 1) return matches[0]!.id;
      const list = space.tags.map((tag) => `${tag.name} (${tag.id})`).join(", ") || "-";
      throw new Error(
        t({
          en: `Tag "${ref}" does not match exactly one tag in ${space.name}. Tags: ${list}`,
          de: `Das Schlagwort „${ref}“ passt nicht zu genau einem Schlagwort in ${space.name}. Schlagwörter: ${list}`,
        }),
      );
    });

  /** A user: `me`, a user ID, or a username with access to the space. */
  const resolveUserId = async (ctx: CloudCliContext, spaceId: string, ref: string): Promise<string> => {
    if (ref === "me") return (await readApi<{ id: string }>(ctx, "/api/me")).id;
    if (UUID.test(ref)) return ref;
    const users = await readApi<SpaceAssignableUser[]>(
      ctx,
      withQuery(api(`/${encodeURIComponent(spaceId)}/assignable-users`), { search: ref }),
    );
    const user = users.find((candidate) => candidate.uid === ref);
    if (user) return user.id;
    throw new Error(
      t({
        en: `No user named "${ref}" can be assigned in this space. Use me, a user ID, or a username with access.`,
        de: `Niemand mit dem Benutzernamen „${ref}“ kann in diesem Space zugewiesen werden. Verwende me, eine Benutzer-ID oder einen Benutzernamen mit Zugriff.`,
      }),
    );
  };

  const resolveUserIds = (ctx: CloudCliContext, spaceId: string, refs: string[]) =>
    Promise.all(refs.map((ref) => resolveUserId(ctx, spaceId, ref)));

  // ==========================
  // Rendering
  // ==========================

  const itemRows = (items: SpaceItem[], space?: SpaceDetail) =>
    items.map((item) => ({
      id: item.id,
      title: item.title,
      column: space?.columns.find((column) => column.id === item.columnId)?.name ?? item.columnId,
      status: item.completedAt ? "completed" : "active",
      priority: item.priority ?? "",
      deadline: item.deadline ?? "",
      assignees: item.assignees?.map((assignee) => assignee.displayName).join(", ") ?? "",
      blockers: item.activeBlockerCount || "",
    }));

  const itemColumns = [
    { key: "id", label: "ID" },
    { key: "title", label: t({ en: "TITLE", de: "TITEL" }) },
    { key: "column", label: t({ en: "COLUMN", de: "SPALTE" }) },
    { key: "status", label: "STATUS" },
    { key: "priority", label: t({ en: "PRIORITY", de: "PRIORITÄT" }) },
    { key: "deadline", label: t({ en: "DUE", de: "FÄLLIG" }) },
    { key: "assignees", label: t({ en: "ASSIGNEES", de: "ZUGEWIESEN" }) },
    { key: "blockers", label: t({ en: "BLOCKERS", de: "BLOCKER" }) },
  ];

  const printItem = (ctx: CloudCliContext, verb: CloudCliText, item: SpaceItem) => {
    if (!printStructured(ctx, item)) ctx.print(`${t(verb)} ${item.title} (${item.id})`);
  };

  const loadDeps = async (ctx: CloudCliContext, item: SpaceItem, page = 1, perPage = 50): Promise<ItemDeps> => {
    const [blockers, blocks] = await Promise.all([
      readApi<SpaceTaskDependency[]>(ctx, itemApi(item, "/blockers")),
      readApi<Paginated<SpaceTaskDependent>>(ctx, withQuery(itemApi(item, "/blocks/page"), { page, per_page: perPage })),
    ]);
    return { item: { id: item.id, title: item.title }, blockers, blocks };
  };

  // ==========================
  // Shared flags and arguments
  // ==========================

  const itemArg = {
    item: arg.required({
      valueLabel: "item",
      description: t({ en: "Item ID or <space>:<title>", de: "Eintrags-ID oder <space>:<titel>" }),
    }),
  };
  const spaceArgDescription = t({ en: "Space ID or exact name", de: "Space-ID oder exakter Name" });
  const fromFlag = flag.string({
    valueLabel: "file|-",
    description: t({ en: "Read the text from a file, or - for stdin", de: "Text aus einer Datei lesen, - für stdin" }),
  });
  const pageFlags = {
    page: flag.int({ min: 1, description: t({ en: "Page number", de: "Seitennummer" }) }),
    perPage: flag.int({ name: "per-page", min: 1, max: 100, description: t({ en: "Entries per page", de: "Einträge pro Seite" }) }),
  };
  const yesFlag = (text: CloudCliText) => ({ yes: confirmFlag(t(text)) });
  const itemFieldFlags = {
    description: flag.string({ description: t({ en: "Description (Markdown)", de: "Beschreibung (Markdown)" }) }),
    from: fromFlag,
    deadline: flag.string({
      description: t({ en: "Deadline as ISO datetime or YYYY-MM-DD", de: "Frist als ISO-Zeitpunkt oder YYYY-MM-DD" }),
    }),
    estimateMinutes: flag.int({
      name: "estimate-minutes",
      min: 1,
      description: t({ en: "Estimated task duration in minutes", de: "Geschätzte Dauer der Aufgabe in Minuten" }),
    }),
    startsAt: flag.string({
      name: "starts-at",
      description: t({ en: "Event start (ISO or YYYY-MM-DD)", de: "Terminbeginn (ISO oder YYYY-MM-DD)" }),
    }),
    endsAt: flag.string({
      name: "ends-at",
      description: t({ en: "Event end (ISO or YYYY-MM-DD)", de: "Terminende (ISO oder YYYY-MM-DD)" }),
    }),
    priority: flag.enum(["low", "medium", "high", "urgent"], { description: t({ en: "Priority", de: "Priorität" }) }),
    tag: flag.stringList({
      description: t({ en: "Tag ID or exact name; repeatable", de: "Schlagwort-ID oder exakter Name; wiederholbar" }),
    }),
    assignee: flag.stringList({
      description: t({ en: "me, user ID, or username; repeatable", de: "me, Benutzer-ID oder Benutzername; wiederholbar" }),
    }),
  };

  const spaceAccessCommands = createAccessCommands({
    resourceLabel: "space",
    resourceArgLabel: "space",
    resourceArgDescription: spaceArgDescription,
    resolveResource: async (ctx, args) => {
      if (!args[0]) throw new Error(t({ en: "Missing space.", de: "Space fehlt." }));
      if (args.length > 1) throw new Error(`Unexpected arguments: ${args.slice(1).join(" ")}`);
      const space = await resolveSpace(ctx, args[0]);
      return { id: space.id, label: `${space.name} (${space.id})` };
    },
    list: (ctx, space) => readApi<AccessEntry[]>(ctx, api(`/${space.id}/access`)),
    grant: (ctx, space, principal: Principal, permission: PermissionLevel) =>
      send<AccessEntry>(ctx, "POST", api(`/${space.id}/access`), { principal, permission }),
    update: async (ctx, space, accessId, permission) => {
      await send<unknown>(ctx, "PATCH", api(`/${space.id}/access/${encodeURIComponent(accessId)}`), { permission });
    },
    revoke: async (ctx, space, accessId) => {
      await readApi<unknown>(ctx, api(`/${space.id}/access/${encodeURIComponent(accessId)}`), { method: "DELETE" });
    },
    examples: {
      list: ['cld spaces access list "Roadmap"'],
      grant: [
        'cld spaces access grant "Roadmap" --user ada.lovelace --permission read',
        'cld spaces access grant "Roadmap" --group "Editors" --permission write',
      ],
      set: ['cld spaces access set "Roadmap" --user ada.lovelace --permission admin'],
      revoke: ['cld spaces access revoke "Roadmap" --user ada.lovelace --yes'],
      searchPrincipals: ['cld spaces access search-principals "Editors" --kind group'],
    },
  });

  const calendarRange = (start: string, end: string) => {
    const from = dateTime(start, "<start>");
    const to = dateTime(end, "<end>", true);
    return { from: from!, to: to! };
  };

  return defineCliCommands({
    name: "spaces",
    summary: t({
      en: "List, add, and change tasks and events by ID or <space>:<title>.",
      de: "Aufgaben und Termine per ID oder <space>:<titel> auflisten, anlegen und ändern.",
    }),
    groupSummaries: {
      access: t({ en: "Manage direct access to spaces", de: "Direkten Zugriff auf Spaces verwalten" }),
      comments: t({ en: "Discuss an item", de: "Einen Eintrag diskutieren" }),
      attachments: t({
        en: "List, upload, download, and delete task images",
        de: "Aufgabenbilder auflisten, hochladen, laden und löschen",
      }),
      checklist: t({ en: "Manage a task checklist", de: "Die Checkliste einer Aufgabe pflegen" }),
      references: t({ en: "Link Cloud resources to an item", de: "Cloud-Ressourcen mit einem Eintrag verknüpfen" }),
      invitation: t({ en: "Prepare Mail invitations for an event", de: "Mail-Einladungen für einen Termin vorbereiten" }),
    },
    commands: [
      // ---------- Browse ----------
      command("ls", {
        summary: t({ en: "List spaces, or the items of one space", de: "Spaces oder die Einträge eines Space auflisten" }),
        args: { space: arg.optional({ valueLabel: "space", description: spaceArgDescription }) },
        flags: {
          q: flag.string({ description: t({ en: "Search text", de: "Suchtext" }) }),
          status: flag.enum(["active", "completed", "all"], {
            description: t({ en: "Completion state (default active)", de: "Erledigungsstand (Standard active)" }),
          }),
          type: flag.enum(["all", "task", "event"], { description: t({ en: "Item type", de: "Eintragstyp" }) }),
          mine: flag.boolean({ description: t({ en: "Only items assigned to me", de: "Nur mir zugewiesene Einträge" }) }),
          unassigned: flag.boolean({ description: t({ en: "Only unassigned items", de: "Nur Einträge ohne Zuweisung" }) }),
          assignee: flag.stringList({
            description: t({ en: "Assignee user ID; repeatable", de: "Benutzer-ID der Zuweisung; wiederholbar" }),
          }),
          ready: flag.boolean({ description: t({ en: "Open tasks without active blockers", de: "Offene Aufgaben ohne aktive Blocker" }) }),
          blocked: flag.boolean({ description: t({ en: "Open tasks with active blockers", de: "Offene Aufgaben mit aktiven Blockern" }) }),
          due: flag.enum(["overdue", "today", "week", "none"], { description: t({ en: "Deadline window", de: "Fristfenster" }) }),
          dueBefore: flag.string({
            name: "due-before",
            description: t({ en: "Deadline before this ISO time or date", de: "Frist vor diesem ISO-Zeitpunkt oder Datum" }),
          }),
          inactive: flag.boolean({
            description: t({ en: "Open tasks without activity for 30 days", de: "Offene Aufgaben ohne Aktivität seit 30 Tagen" }),
          }),
          priority: flag.stringList({ description: t({ en: "Priority; repeatable", de: "Priorität; wiederholbar" }) }),
          column: flag.stringList({ description: t({ en: "Column ID or name; repeatable", de: "Spalten-ID oder -Name; wiederholbar" }) }),
          tag: flag.stringList({ description: t({ en: "Tag ID or name; repeatable", de: "Schlagwort-ID oder -Name; wiederholbar" }) }),
          sort: flag.enum(["column", "priority", "deadline", "created", "updated", "title"], {
            description: t({ en: "Sort field (default updated)", de: "Sortierfeld (Standard updated)" }),
          }),
          ascending: flag.boolean({ description: t({ en: "Sort ascending", de: "Aufsteigend sortieren" }) }),
          ...pageFlags,
        },
        examples: ["cld spaces ls", 'cld spaces ls "Roadmap" --mine --due-before 2026-10-01', "cld spaces ls Space1 --ready --json"],
        async run({ ctx, args, flags }) {
          if (!args.space) {
            const query = flags.q?.toLowerCase();
            const spaces = (await readApi<Space[]>(ctx, api())).filter(
              (space) => !query || space.name.toLowerCase().includes(query) || space.description?.toLowerCase().includes(query),
            );
            printRows(ctx, spaces, spaces, [
              { key: "id", label: "ID" },
              { key: "name", label: "NAME" },
              { key: "updatedAt", label: t({ en: "UPDATED", de: "GEÄNDERT" }) },
            ]);
            return;
          }
          if ([flags.ready, flags.blocked].filter(Boolean).length > 1 || [flags.mine, flags.unassigned].filter(Boolean).length > 1)
            throw new Error(
              t({
                en: "Pass only one of --ready or --blocked, and only one of --mine or --unassigned.",
                de: "Übergib nur eines von --ready oder --blocked und nur eines von --mine oder --unassigned.",
              }),
            );
          const openTasks = flags.ready || flags.blocked;
          if (openTasks && (flags.type === "event" || (flags.status && flags.status !== "active")))
            throw new Error(t({ en: "--ready and --blocked select open tasks.", de: "--ready und --blocked wählen offene Aufgaben." }));
          const space = await loadSpace(ctx, (await resolveSpace(ctx, args.space)).id);
          const result = await send<ItemListResult>(ctx, "POST", api(`/${space.id}/items/filter`), {
            type: openTasks ? "task" : (flags.type ?? "all"),
            status: openTasks ? "active" : (flags.status ?? "active"),
            blocked: flags.ready ? false : flags.blocked ? true : undefined,
            assignedTo: flags.mine ? "me" : flags.unassigned ? "unassigned" : "all",
            assigneeIds: flags.assignee,
            priority: flags.priority,
            columnIds: flags.column.map((ref) => resolveColumnId(space, ref)),
            tagIds: resolveTagIds(space, flags.tag),
            deadlineFilter: flags.due ?? "all",
            deadlineBefore: dateTime(flags.dueBefore, "--due-before"),
            activity: flags.inactive ? "inactive" : "all",
            search: flags.q,
            sort: flags.sort ?? "updated",
            sortDesc: !flags.ascending,
            groupBy: "none",
            page: flags.page ?? 1,
            pageSize: flags.perPage ?? 50,
          });
          printRows(ctx, result, itemRows(result.items, space), itemColumns);
          if (ctx.options.output === "text" && result.page < result.totalPages)
            ctx.error(`${t({ en: "More items", de: "Weitere Einträge" })}: --page ${result.page + 1}`);
        },
      }),
      command("show", {
        summary: t({ en: "Show an item, or a space with <space>:", de: "Einen Eintrag zeigen, oder einen Space mit <space>:" }),
        args: {
          target: arg.required({
            valueLabel: "item|space:",
            description: t({
              en: "Item ID, <space>:<title>, or <space>: for the space itself",
              de: "Eintrags-ID, <space>:<titel> oder <space>: für den Space selbst",
            }),
          }),
        },
        flags: {
          context: flag.boolean({
            description: t({
              en: "Include work state, checklist, dependencies, references, and a comments page",
              de: "Arbeitsstand, Checkliste, Abhängigkeiten, Verweise und eine Kommentarseite einbeziehen",
            }),
          }),
          ...pageFlags,
        },
        examples: [
          'cld spaces show "Roadmap":',
          'cld spaces show "Roadmap":"Publish release notes"',
          "cld spaces show Item01 --context --json",
        ],
        async run({ ctx, args, flags }) {
          const address = parseCliAddress(args.target);
          if (address.kind === "path" && address.path === "") {
            const space = await loadSpace(ctx, (await resolveSpace(ctx, args.target)).id);
            if (!printStructured(ctx, space)) {
              ctx.print(`${space.name} (${space.id})`);
              if (space.description) ctx.print(space.description);
              ctx.print(`${t({ en: "columns", de: "Spalten" })}: ${space.columns.map((c) => `${c.name} (${c.id})`).join(", ") || "-"}`);
              ctx.print(
                `${t({ en: "tags", de: "Schlagwörter" })}: ${space.tags.map((tag) => `${tag.name} (${tag.id})`).join(", ") || "-"}`,
              );
            }
            return;
          }
          const item = await resolveItem(ctx, args.target);
          const attachments = isTask(item) ? await readApi<SpaceItemAttachment[]>(ctx, itemApi(item, "/attachments")) : undefined;
          if (flags.context) {
            const page = flags.page ?? 1;
            const perPage = flags.perPage ?? 50;
            const [comments, references, work, checklist, deps] = await Promise.all([
              readApi<Paginated<SpaceComment>>(ctx, withQuery(itemApi(item, "/comments/page"), { page, per_page: perPage })),
              readApi<SpaceItemResourceReference[]>(ctx, itemApi(item, "/references")),
              attachments ? readApi<TaskWork>(ctx, itemApi(item, "/work")) : Promise.resolve(null),
              attachments ? readApi<SpaceTaskChecklistEntry[]>(ctx, itemApi(item, "/checklist")) : Promise.resolve([]),
              attachments ? loadDeps(ctx, item, page, perPage) : Promise.resolve(null),
            ]);
            const context = {
              ...item,
              attachments,
              work,
              checklist,
              blockers: deps?.blockers ?? [],
              blocks: deps?.blocks ?? null,
              references,
              comments,
            };
            if (!printStructured(ctx, context)) ctx.print(JSON.stringify(context, null, 2));
            return;
          }
          const detail = attachments ? { ...item, attachments } : item;
          if (printStructured(ctx, detail)) return;
          ctx.print(`${item.title} (${item.id})`);
          if (item.description) ctx.print(item.description);
          ctx.print(`space: ${item.spaceId}`);
          ctx.print(`status: ${item.completedAt ? "completed" : "active"}`);
          if (item.deadline) ctx.print(`${t({ en: "due", de: "fällig" })}: ${item.deadline}`);
          if (item.startsAt) ctx.print(`${t({ en: "time", de: "Zeit" })}: ${item.startsAt} – ${item.endsAt ?? ""}`);
          if (item.assignees?.length)
            ctx.print(`${t({ en: "assignees", de: "zugewiesen" })}: ${item.assignees.map((a) => a.displayName).join(", ")}`);
          if (item.activeBlockerCount > 0) ctx.print(`${t({ en: "blocked by", de: "blockiert von" })}: ${item.activeBlockerCount}`);
          if (attachments?.length)
            ctx.print(`${t({ en: "attachments", de: "Anhänge" })}: ${attachments.map((a) => a.filename).join(", ")}`);
        },
      }),

      // ---------- Spaces ----------
      command("create", {
        summary: t({ en: "Create a space", de: "Einen Space anlegen" }),
        args: { name: arg.required({ description: t({ en: "Space name", de: "Name des Space" }) }) },
        flags: {
          description: flag.string({ description: t({ en: "Description", de: "Beschreibung" }) }),
          color: flag.string({ description: t({ en: "Color as #rrggbb", de: "Farbe als #rrggbb" }) }),
        },
        async run({ ctx, args, flags }) {
          const space = await send<Space>(ctx, "POST", api(), {
            name: args.name,
            description: flags.description,
            color: flags.color ?? "#3b82f6",
          });
          if (!printStructured(ctx, space)) ctx.print(`${t({ en: "Created", de: "Angelegt" })} ${space.name} (${space.id})`);
        },
      }),

      // ---------- Items ----------
      command("add", {
        summary: t({ en: "Add a task or event to a space", de: "Eine Aufgabe oder einen Termin zu einem Space hinzufügen" }),
        args: {
          target: arg.required({
            valueLabel: "space:title",
            description: t({ en: "<space>:<title> of the new item", de: "<space>:<titel> des neuen Eintrags" }),
          }),
        },
        flags: {
          column: flag.string({
            description: t({
              en: "Column ID or exact name (default: first column)",
              de: "Spalten-ID oder exakter Name (Standard: erste Spalte)",
            }),
          }),
          ...itemFieldFlags,
        },
        examples: [
          'cld spaces add "Roadmap":"Publish release notes" --deadline 2026-10-20 --assignee me',
          'cld spaces add "Roadmap":"Launch review" --starts-at 2026-10-20T10:00:00Z --ends-at 2026-10-20T11:00:00Z',
        ],
        async run({ ctx, args, flags }) {
          const address = parseCliAddress(args.target);
          if (address.kind !== "path" || !address.path.trim())
            throw new Error(
              t({
                en: `"${args.target}" names no new item. Use <space>:<title>.`,
                de: `„${args.target}“ benennt keinen neuen Eintrag. Verwende <space>:<titel>.`,
              }),
            );
          const space = await loadSpace(ctx, (await resolveSpace(ctx, `${address.container}:`)).id);
          const columnId = flags.column ? resolveColumnId(space, flags.column) : space.columns[0]?.id;
          if (!columnId) throw new Error(t({ en: `${space.name} has no column.`, de: `${space.name} hat keine Spalte.` }));
          const item = await send<SpaceItem>(ctx, "POST", api(`/${space.id}/items`), {
            columnId,
            title: address.path,
            description: await readText(flags.description, flags.from, "description"),
            startsAt: dateTime(flags.startsAt, "--starts-at"),
            endsAt: dateTime(flags.endsAt, "--ends-at", true),
            deadline: dateTime(flags.deadline, "--deadline", true),
            estimatedDurationMinutes: flags.estimateMinutes,
            priority: flags.priority,
            assigneeIds: await resolveUserIds(ctx, space.id, flags.assignee),
            tagIds: resolveTagIds(space, flags.tag),
          });
          printItem(ctx, { en: "Added", de: "Hinzugefügt" }, item);
        },
      }),
      command("set", {
        summary: t({ en: "Change item fields", de: "Felder eines Eintrags ändern" }),
        args: itemArg,
        flags: {
          title: flag.string({ description: t({ en: "Title", de: "Titel" }) }),
          ...itemFieldFlags,
          clearEstimate: flag.boolean({ name: "clear-estimate", description: t({ en: "Remove the estimate", de: "Schätzung entfernen" }) }),
          clearAssignees: flag.boolean({
            name: "clear-assignees",
            description: t({ en: "Remove all assignees", de: "Alle Zuweisungen entfernen" }),
          }),
          clearTags: flag.boolean({ name: "clear-tags", description: t({ en: "Remove all tags", de: "Alle Schlagwörter entfernen" }) }),
        },
        examples: [
          'cld spaces set "Roadmap":"Publish release notes" --priority high --from notes.md',
          "cld spaces set Item01 --clear-tags",
        ],
        async run({ ctx, args, flags }) {
          if ((flags.assignee.length && flags.clearAssignees) || (flags.tag.length && flags.clearTags))
            throw new Error(
              t({
                en: "Pass either new values or the matching --clear flag, not both.",
                de: "Übergib entweder neue Werte oder das passende --clear-Flag, nicht beides.",
              }),
            );
          const item = await resolveItem(ctx, args.item);
          const space = flags.tag.length ? await loadSpace(ctx, item.spaceId) : null;
          const body: Record<string, unknown> = {
            title: flags.title,
            description: await readText(flags.description, flags.from, "description"),
            startsAt: dateTime(flags.startsAt, "--starts-at"),
            endsAt: dateTime(flags.endsAt, "--ends-at", true),
            deadline: dateTime(flags.deadline, "--deadline", true),
            estimatedDurationMinutes: flags.clearEstimate ? null : flags.estimateMinutes,
            priority: flags.priority,
          };
          if (flags.assignee.length || flags.clearAssignees) body.assigneeIds = await resolveUserIds(ctx, item.spaceId, flags.assignee);
          if (flags.tag.length || flags.clearTags) body.tagIds = space ? resolveTagIds(space, flags.tag) : [];
          const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
          if (Object.keys(changes).length === 0) throw new Error(t({ en: "Nothing to change.", de: "Nichts zu ändern." }));
          printItem(ctx, { en: "Updated", de: "Aktualisiert" }, await send<SpaceItem>(ctx, "PATCH", itemApi(item), changes));
        },
      }),
      command("mv", {
        summary: t({
          en: "Move an item to another column of its space",
          de: "Einen Eintrag in eine andere Spalte seines Space verschieben",
        }),
        args: {
          ...itemArg,
          column: arg.required({ description: t({ en: "Column ID or exact name", de: "Spalten-ID oder exakter Name" }) }),
        },
        examples: ['cld spaces mv "Roadmap":"Publish release notes" "In progress"'],
        async run({ ctx, args }) {
          const item = await resolveItem(ctx, args.item);
          const columnId = resolveColumnId(await loadSpace(ctx, item.spaceId), args.column);
          printItem(ctx, { en: "Moved", de: "Verschoben" }, await send<SpaceItem>(ctx, "PATCH", itemApi(item), { columnId }));
        },
      }),
      command("rm", {
        summary: t({ en: "Delete an item", de: "Einen Eintrag löschen" }),
        args: itemArg,
        flags: yesFlag({ en: "Confirm the deletion", de: "Löschen bestätigen" }),
        async run({ ctx, args, flags }) {
          requireYes(flags.yes);
          const item = await resolveItem(ctx, args.item);
          await readApi<unknown>(ctx, itemApi(item), { method: "DELETE" });
          if (!printStructured(ctx, { deleted: { id: item.id, spaceId: item.spaceId, title: item.title } }))
            ctx.print(`${t({ en: "Deleted", de: "Gelöscht" })} ${item.title} (${item.id})`);
        },
      }),

      // ---------- Quick actions ----------
      ...(["done", "reopen"] as const).map((action) =>
        command(action, {
          summary:
            action === "done"
              ? t({ en: "Complete an item, optionally with a result", de: "Einen Eintrag erledigen, optional mit Ergebnis" })
              : t({ en: "Reopen a completed item", de: "Einen erledigten Eintrag wieder öffnen" }),
          args: itemArg,
          flags:
            action === "done"
              ? {
                  result: flag.string({ description: t({ en: "Result with verification", de: "Ergebnis mit Nachweis" }) }),
                  from: fromFlag,
                  commit: flag.string({ description: t({ en: "Commit SHA; needs a result", de: "Commit-SHA; braucht ein Ergebnis" }) }),
                  claimId: flag.string({ name: "claim-id", description: t({ en: "Current claim ID", de: "Aktuelle Übernahme-ID" }) }),
                }
              : {},
          async run({ ctx, args, flags }) {
            const done = flags as { result?: string; from?: string; commit?: string; claimId?: string };
            const item = await resolveItem(ctx, args.item);
            const updated = await send<SpaceItem>(ctx, "POST", itemApi(item, "/completed"), {
              completed: action === "done",
              result: await readText(done.result, done.from, "result"),
              commit: done.commit,
              claimId: done.claimId,
            });
            printItem(ctx, action === "done" ? { en: "Completed", de: "Erledigt" } : { en: "Reopened", de: "Wieder geöffnet" }, updated);
          },
        }),
      ),
      command("assign", {
        summary: t({ en: "Assign an item to one person, or to nobody", de: "Einen Eintrag einer Person oder niemandem zuweisen" }),
        args: {
          ...itemArg,
          user: arg.required({
            valueLabel: "user|me|none",
            description: t({ en: "me, none, a user ID, or a username", de: "me, none, eine Benutzer-ID oder ein Benutzername" }),
          }),
        },
        examples: ['cld spaces assign "Roadmap":"Publish release notes" me', "cld spaces assign Item01 none"],
        async run({ ctx, args }) {
          const item = await resolveItem(ctx, args.item);
          const assigneeIds = args.user === "none" ? [] : [await resolveUserId(ctx, item.spaceId, args.user)];
          printItem(ctx, { en: "Assigned", de: "Zugewiesen" }, await send<SpaceItem>(ctx, "PATCH", itemApi(item), { assigneeIds }));
        },
      }),
      command("due", {
        summary: t({ en: "Set or clear an item deadline", de: "Die Frist eines Eintrags setzen oder entfernen" }),
        args: {
          ...itemArg,
          date: arg.required({
            valueLabel: "date|none",
            description: t({ en: "ISO datetime, YYYY-MM-DD (end of day), or none", de: "ISO-Zeitpunkt, YYYY-MM-DD (Tagesende) oder none" }),
          }),
        },
        examples: ['cld spaces due "Roadmap":"Publish release notes" 2026-10-20', "cld spaces due Item01 none"],
        async run({ ctx, args }) {
          const item = await resolveItem(ctx, args.item);
          const deadline = args.date === "none" ? null : dateTime(args.date, "<date>", true);
          printItem(ctx, { en: "Updated", de: "Aktualisiert" }, await send<SpaceItem>(ctx, "PATCH", itemApi(item), { deadline }));
        },
      }),
      command("deps", {
        summary: t({
          en: "Show what blocks a task and what it blocks; --add or --rm a blocker",
          de: "Zeigen, was eine Aufgabe blockiert und was sie blockiert; Blocker mit --add oder --rm ändern",
        }),
        args: itemArg,
        flags: {
          add: flag.string({
            valueLabel: "item",
            description: t({ en: "Task that must be done first", de: "Aufgabe, die zuerst erledigt sein muss" }),
          }),
          rm: flag.string({ valueLabel: "item", description: t({ en: "Blocker to remove", de: "Zu entfernender Blocker" }) }),
          ...pageFlags,
        },
        examples: ['cld spaces deps "Roadmap":"Publish release notes" --add "Roadmap":"Approve release"', "cld spaces deps Item01 --json"],
        async run({ ctx, args, flags }) {
          const item = await resolveItem(ctx, args.item);
          if (flags.add) {
            const blocker = await resolveItem(ctx, flags.add);
            await send<SpaceTaskDependency>(ctx, "POST", itemApi(item, "/blockers"), { blockerItemId: blocker.id });
          }
          if (flags.rm) {
            const blocker = await resolveItem(ctx, flags.rm);
            await send<unknown>(ctx, "DELETE", itemApi(item, "/blockers"), { blockerItemId: blocker.id });
          }
          const deps = await loadDeps(ctx, item, flags.page, flags.perPage);
          if (printStructured(ctx, deps)) return;
          const status = (entry: { completedAt: string | null }) => (entry.completedAt ? "completed" : "active");
          ctx.table(
            [
              ...deps.blockers.map((entry) => ({
                relation: "blocked by",
                title: entry.blocker.title,
                status: status(entry.blocker),
                id: entry.blocker.id,
              })),
              ...deps.blocks.items.map((entry) => ({
                relation: "blocks",
                title: entry.dependent.title,
                status: status(entry.dependent),
                id: entry.dependent.id,
              })),
            ],
            [
              { key: "relation", label: t({ en: "RELATION", de: "BEZIEHUNG" }) },
              { key: "title", label: t({ en: "TITLE", de: "TITEL" }) },
              { key: "status", label: "STATUS" },
              { key: "id", label: "ID" },
            ],
          );
          if (deps.blocks.hasNext)
            ctx.error(`${t({ en: "More blocked tasks", de: "Weitere blockierte Aufgaben" })}: --page ${deps.blocks.page + 1}`);
        },
      }),

      // ---------- Comments ----------
      command("comments list", {
        summary: t({ en: "List item comments", de: "Kommentare eines Eintrags auflisten" }),
        args: itemArg,
        flags: pageFlags,
        async run({ ctx, args, flags }) {
          const item = await resolveItem(ctx, args.item);
          const page = await readApi<Paginated<SpaceComment>>(
            ctx,
            withQuery(itemApi(item, "/comments/page"), { page: flags.page, per_page: flags.perPage }),
          );
          printRows(
            ctx,
            page,
            page.items.map((comment) => ({
              id: comment.id,
              author: comment.userName ?? comment.userId ?? "",
              content: comment.content.replace(/\s+/g, " ").slice(0, 80),
              createdAt: comment.createdAt,
            })),
            [
              { key: "id", label: "ID" },
              { key: "author", label: t({ en: "AUTHOR", de: "AUTOR" }) },
              { key: "content", label: t({ en: "CONTENT", de: "INHALT" }) },
              { key: "createdAt", label: t({ en: "CREATED", de: "ERSTELLT" }) },
            ],
          );
          if (ctx.options.output === "text" && page.hasNext)
            ctx.error(`${t({ en: "More comments", de: "Weitere Kommentare" })}: --page ${page.page + 1}`);
        },
      }),
      command("comments add", {
        summary: t({ en: "Comment on an item", de: "Einen Eintrag kommentieren" }),
        args: itemArg,
        flags: { content: flag.string({ description: t({ en: "Comment text", de: "Kommentartext" }) }), from: fromFlag },
        async run({ ctx, args, flags }) {
          const content = await requireText(flags.content, flags.from, "content");
          const item = await resolveItem(ctx, args.item);
          const comment = await send<SpaceComment>(ctx, "POST", itemApi(item, "/comments"), { content });
          if (!printStructured(ctx, comment)) ctx.print(`${t({ en: "Added comment", de: "Kommentar hinzugefügt" })} ${comment.id}`);
        },
      }),
      command("comments update", {
        summary: t({ en: "Change your comment", de: "Eigenen Kommentar ändern" }),
        args: { ...itemArg, comment: arg.required({ description: t({ en: "Comment ID", de: "Kommentar-ID" }) }) },
        flags: { content: flag.string({ description: t({ en: "Comment text", de: "Kommentartext" }) }), from: fromFlag },
        async run({ ctx, args, flags }) {
          const content = await requireText(flags.content, flags.from, "content");
          const item = await resolveItem(ctx, args.item);
          const comment = await send<SpaceComment>(ctx, "PATCH", itemApi(item, `/comments/${encodeURIComponent(args.comment)}`), {
            content,
          });
          if (!printStructured(ctx, comment)) ctx.print(`${t({ en: "Updated comment", de: "Kommentar aktualisiert" })} ${comment.id}`);
        },
      }),
      command("comments delete", {
        summary: t({ en: "Delete a comment", de: "Einen Kommentar löschen" }),
        args: { ...itemArg, comment: arg.required({ description: t({ en: "Comment ID", de: "Kommentar-ID" }) }) },
        flags: yesFlag({ en: "Confirm the deletion", de: "Löschen bestätigen" }),
        async run({ ctx, args, flags }) {
          requireYes(flags.yes);
          const item = await resolveItem(ctx, args.item);
          await readApi<unknown>(ctx, itemApi(item, `/comments/${encodeURIComponent(args.comment)}`), { method: "DELETE" });
          if (!printStructured(ctx, { deleted: { id: args.comment, itemId: item.id } }))
            ctx.print(`${t({ en: "Deleted comment", de: "Kommentar gelöscht" })} ${args.comment}`);
        },
      }),

      // ---------- Attachments ----------
      command("attachments list", {
        summary: t({ en: "List task attachments", de: "Anhänge einer Aufgabe auflisten" }),
        args: itemArg,
        async run({ ctx, args }) {
          const item = await resolveItem(ctx, args.item);
          const attachments = await readApi<SpaceItemAttachment[]>(ctx, itemApi(item, "/attachments"));
          printRows(ctx, attachments, attachments, [
            { key: "id", label: "ID" },
            { key: "filename", label: t({ en: "FILE", de: "DATEI" }) },
            { key: "mimeType", label: t({ en: "TYPE", de: "TYP" }) },
            { key: "sizeBytes", label: "BYTES" },
            { key: "createdAt", label: t({ en: "CREATED", de: "ERSTELLT" }) },
          ]);
        },
      }),
      command("attachments add", {
        summary: t({ en: "Upload an image to a task", de: "Ein Bild zu einer Aufgabe hochladen" }),
        args: { ...itemArg, file: arg.required({ description: t({ en: "Local image file", de: "Lokale Bilddatei" }) }) },
        async run({ ctx, args }) {
          const path = expandHome(args.file);
          const file = Bun.file(path);
          if (!(await file.exists()))
            throw new Error(t({ en: `File "${args.file}" was not found.`, de: `Datei „${args.file}“ nicht gefunden.` }));
          const item = await resolveItem(ctx, args.item);
          const form = new FormData();
          form.set("file", file, basename(path));
          const attachment = await readApi<SpaceItemAttachment>(ctx, itemApi(item, "/attachments"), { method: "POST", body: form });
          if (!printStructured(ctx, attachment))
            ctx.print(`${t({ en: "Added", de: "Hinzugefügt" })} ${attachment.filename} (${attachment.id}) → ${item.title}`);
        },
      }),
      command("attachments download", {
        summary: t({ en: "Download a task attachment", de: "Einen Aufgabenanhang herunterladen" }),
        args: {
          ...itemArg,
          attachment: arg.required({ description: t({ en: "Attachment ID or file name", de: "Anhang-ID oder Dateiname" }) }),
        },
        flags: {
          out: flag.string({
            description: t({ en: "Destination file (default: its file name)", de: "Zieldatei (Standard: ihr Dateiname)" }),
          }),
        },
        async run({ ctx, args, flags }) {
          const item = await resolveItem(ctx, args.item);
          const attachment = await resolveAttachment(ctx, item, args.attachment);
          const response = await ctx.fetch(itemApi(item, `/attachments/${encodeURIComponent(attachment.id)}/content?download=true`));
          if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
          const out = expandHome(flags.out ?? attachment.filename);
          await Bun.write(out, response);
          if (!printStructured(ctx, { attachment, out }))
            ctx.print(`${t({ en: "Saved", de: "Gespeichert" })} ${attachment.filename} → ${out}`);
        },
      }),
      command("attachments delete", {
        summary: t({ en: "Delete a task attachment", de: "Einen Aufgabenanhang löschen" }),
        args: {
          ...itemArg,
          attachment: arg.required({ description: t({ en: "Attachment ID or file name", de: "Anhang-ID oder Dateiname" }) }),
        },
        flags: yesFlag({ en: "Confirm the deletion", de: "Löschen bestätigen" }),
        async run({ ctx, args, flags }) {
          requireYes(flags.yes);
          const item = await resolveItem(ctx, args.item);
          const attachment = await resolveAttachment(ctx, item, args.attachment);
          await readApi<unknown>(ctx, itemApi(item, `/attachments/${encodeURIComponent(attachment.id)}`), { method: "DELETE" });
          if (!printStructured(ctx, { deleted: attachment })) ctx.print(`${t({ en: "Deleted", de: "Gelöscht" })} ${attachment.filename}`);
        },
      }),

      // ---------- Agent work ----------
      command("work", {
        summary: t({ en: "Read the current claim, progress, and result", de: "Aktuelle Übernahme, Fortschritt und Ergebnis lesen" }),
        args: itemArg,
        async run({ ctx, args }) {
          const work = await readApi<TaskWork>(ctx, itemApi(await resolveItem(ctx, args.item), "/work"));
          if (!printStructured(ctx, work)) ctx.print(JSON.stringify(work, null, 2));
        },
      }),
      command("claim", {
        summary: t({
          en: "Claim an open, unblocked task for a worker",
          de: "Eine offene, unblockierte Aufgabe für einen Worker übernehmen",
        }),
        args: itemArg,
        flags: {
          claimId: flag.string({
            name: "claim-id",
            required: true,
            description: t({ en: "Worker-generated UUID", de: "Vom Worker erzeugte UUID" }),
          }),
        },
        async run({ ctx, args, flags }) {
          const work = await send<TaskWork>(ctx, "POST", itemApi(await resolveItem(ctx, args.item), "/claim"), { claimId: flags.claimId });
          if (!printStructured(ctx, work)) ctx.print(JSON.stringify(work, null, 2));
        },
      }),
      command("release", {
        summary: t({ en: "Release a task claim", de: "Eine Aufgabenübernahme freigeben" }),
        args: itemArg,
        flags: {
          claimId: flag.string({ name: "claim-id", required: true, description: t({ en: "Claim ID", de: "Übernahme-ID" }) }),
          force: flag.boolean({
            description: t({
              en: "Admin recovery of the exact observed claim",
              de: "Admin-Wiederherstellung der genau beobachteten Übernahme",
            }),
          }),
        },
        async run({ ctx, args, flags }) {
          const work = await send<TaskWork>(ctx, "POST", itemApi(await resolveItem(ctx, args.item), "/release"), {
            claimId: flags.claimId,
            force: flags.force,
          });
          if (!printStructured(ctx, work)) ctx.print(JSON.stringify(work, null, 2));
        },
      }),
      command("progress", {
        summary: t({ en: "Save a progress and handoff note", de: "Eine Fortschritts- und Übergabenotiz speichern" }),
        args: itemArg,
        flags: {
          content: flag.string({ description: t({ en: "Note text", de: "Notiztext" }) }),
          from: fromFlag,
          claimId: flag.string({
            name: "claim-id",
            description: t({ en: "Claim ID, when claimed", de: "Übernahme-ID, falls übernommen" }),
          }),
        },
        async run({ ctx, args, flags }) {
          const content = await requireText(flags.content, flags.from, "content");
          const work = await send<TaskWork>(ctx, "POST", itemApi(await resolveItem(ctx, args.item), "/progress"), {
            claimId: flags.claimId,
            content,
          });
          if (!printStructured(ctx, work)) ctx.print(JSON.stringify(work, null, 2));
        },
      }),
      command("activity", {
        summary: t({ en: "Read a page of item activity", de: "Eine Seite der Eintragsaktivität lesen" }),
        args: itemArg,
        flags: {
          cursor: flag.string({ description: t({ en: "nextCursor of the previous page", de: "nextCursor der vorigen Seite" }) }),
          limit: flag.int({
            min: 1,
            max: 100,
            description: t({ en: "Entries per page (default 30)", de: "Einträge pro Seite (Standard 30)" }),
          }),
        },
        async run({ ctx, args, flags }) {
          const item = await resolveItem(ctx, args.item);
          const result = await readApi<unknown>(
            ctx,
            withQuery(itemApi(item, "/activity"), { limit: flags.limit ?? 30, cursor: flags.cursor }),
          );
          if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
        },
      }),

      // ---------- Checklist ----------
      command("checklist list", {
        summary: t({ en: "List checklist entries", de: "Checklisteneinträge auflisten" }),
        args: itemArg,
        async run({ ctx, args }) {
          const entries = await readApi<SpaceTaskChecklistEntry[]>(ctx, itemApi(await resolveItem(ctx, args.item), "/checklist"));
          printRows(ctx, entries, entries, [
            { key: "id", label: "ID" },
            { key: "completed", label: t({ en: "DONE", de: "ERLEDIGT" }) },
            { key: "label", label: t({ en: "LABEL", de: "TEXT" }) },
          ]);
        },
      }),
      command("checklist add", {
        summary: t({ en: "Add a checklist entry", de: "Einen Checklisteneintrag hinzufügen" }),
        args: { ...itemArg, label: arg.required({ description: t({ en: "Entry text", de: "Text des Eintrags" }) }) },
        flags: { completed: flag.boolean({ description: t({ en: "Add it as completed", de: "Als erledigt hinzufügen" }) }) },
        async run({ ctx, args, flags }) {
          const entry = await send<SpaceTaskChecklistEntry>(ctx, "POST", itemApi(await resolveItem(ctx, args.item), "/checklist"), {
            label: args.label,
            ...(flags.completed ? { completed: true } : {}),
          });
          if (!printStructured(ctx, entry)) ctx.print(`${t({ en: "Added", de: "Hinzugefügt" })} ${entry.label} (${entry.id})`);
        },
      }),
      command("checklist update", {
        summary: t({ en: "Change a checklist entry", de: "Einen Checklisteneintrag ändern" }),
        args: { ...itemArg, entry: arg.required({ description: t({ en: "Entry ID", de: "Eintrags-ID" }) }) },
        flags: {
          label: flag.string({ description: t({ en: "New text", de: "Neuer Text" }) }),
          completed: flag.boolean({ description: t({ en: "Mark completed", de: "Als erledigt markieren" }) }),
          reopen: flag.boolean({ description: t({ en: "Mark open", de: "Als offen markieren" }) }),
        },
        async run({ ctx, args, flags }) {
          if (flags.completed && flags.reopen)
            throw new Error(t({ en: "Pass only one of --completed or --reopen.", de: "Übergib nur --completed oder --reopen." }));
          const body = {
            ...(flags.label !== undefined ? { label: flags.label } : {}),
            ...(flags.completed || flags.reopen ? { completed: flags.completed } : {}),
          };
          if (Object.keys(body).length === 0) throw new Error(t({ en: "Nothing to change.", de: "Nichts zu ändern." }));
          const item = await resolveItem(ctx, args.item);
          const entry = await send<SpaceTaskChecklistEntry>(
            ctx,
            "PATCH",
            itemApi(item, `/checklist/${encodeURIComponent(args.entry)}`),
            body,
          );
          if (!printStructured(ctx, entry)) ctx.print(`${t({ en: "Updated", de: "Aktualisiert" })} ${entry.label} (${entry.id})`);
        },
      }),
      command("checklist delete", {
        summary: t({ en: "Delete a checklist entry", de: "Einen Checklisteneintrag löschen" }),
        args: { ...itemArg, entry: arg.required({ description: t({ en: "Entry ID", de: "Eintrags-ID" }) }) },
        flags: yesFlag({ en: "Confirm the deletion", de: "Löschen bestätigen" }),
        async run({ ctx, args, flags }) {
          requireYes(flags.yes);
          const item = await resolveItem(ctx, args.item);
          const result = await readApi<{ deleted: boolean }>(ctx, itemApi(item, `/checklist/${encodeURIComponent(args.entry)}`), {
            method: "DELETE",
          });
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Deleted", de: "Gelöscht" })} ${args.entry}`);
        },
      }),

      // ---------- References ----------
      command("references list", {
        summary: t({ en: "List linked Cloud resources", de: "Verknüpfte Cloud-Ressourcen auflisten" }),
        args: itemArg,
        async run({ ctx, args }) {
          const references = await readApi<SpaceItemResourceReference[]>(ctx, itemApi(await resolveItem(ctx, args.item), "/references"));
          if (!printStructured(ctx, references)) ctx.print(JSON.stringify(references, null, 2));
        },
      }),
      ...(["add", "delete"] as const).map((operation) =>
        command(`references ${operation}`, {
          summary:
            operation === "add"
              ? t({ en: "Link a Cloud resource", de: "Eine Cloud-Ressource verknüpfen" })
              : t({ en: "Remove a resource link", de: "Eine Ressourcenverknüpfung entfernen" }),
          args: itemArg,
          flags: {
            type: flag.string({
              required: true,
              description: t({ en: "Resource type, e.g. notebooks.note", de: "Ressourcentyp, z. B. notebooks.note" }),
            }),
            id: flag.string({ required: true, description: t({ en: "Resource ID", de: "Ressourcen-ID" }) }),
            ...(operation === "add"
              ? { label: flag.string({ description: t({ en: "Display label", de: "Anzeigename" }) }) }
              : yesFlag({ en: "Confirm the removal", de: "Entfernen bestätigen" })),
          },
          async run({ ctx, args, flags }) {
            const input = flags as { type?: string; id?: string; label?: string; yes?: boolean };
            if (operation === "delete") requireYes(input.yes === true);
            const item = await resolveItem(ctx, args.item);
            const ref = { type: input.type, id: input.id };
            const result = await send<unknown>(
              ctx,
              operation === "add" ? "POST" : "DELETE",
              itemApi(item, "/references"),
              operation === "add" ? { ref, label: input.label } : { ref },
            );
            if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
          },
        }),
      ),

      // ---------- Calendar ----------
      command("calendar", {
        summary: t({ en: "List events and deadlines in a time range", de: "Termine und Fristen in einem Zeitraum auflisten" }),
        args: {
          start: arg.required({ description: t({ en: "Start (ISO or YYYY-MM-DD)", de: "Beginn (ISO oder YYYY-MM-DD)" }) }),
          end: arg.required({
            description: t({ en: "End (ISO or YYYY-MM-DD, inclusive)", de: "Ende (ISO oder YYYY-MM-DD, einschließlich)" }),
          }),
        },
        flags: { space: flag.string({ description: t({ en: "Only this space", de: "Nur dieser Space" }) }) },
        examples: ["cld spaces calendar 2026-10-01 2026-10-31", 'cld spaces calendar 2026-10-01 2026-10-31 --space "Roadmap" --json'],
        async run({ ctx, args, flags }) {
          const range = calendarRange(args.start, args.end);
          const space = flags.space ? await resolveSpace(ctx, flags.space) : null;
          const items = (await readApi<CalendarItem[]>(ctx, withQuery(api("/calendar"), range))).filter(
            (item) => !space || item.spaceId === space.id,
          );
          printRows(ctx, items, items, [
            { key: "id", label: "ID" },
            { key: "spaceName", label: "SPACE" },
            { key: "title", label: t({ en: "TITLE", de: "TITEL" }) },
            { key: "startsAt", label: t({ en: "START", de: "BEGINN" }) },
            { key: "endsAt", label: t({ en: "END", de: "ENDE" }) },
            { key: "deadline", label: t({ en: "DUE", de: "FÄLLIG" }) },
          ]);
        },
      }),
      command("overlap", {
        summary: t({
          en: "Find events overlapping a proposed time",
          de: "Termine finden, die sich mit einer geplanten Zeit überschneiden",
        }),
        args: {
          start: arg.required({ description: t({ en: "Start (ISO or YYYY-MM-DD)", de: "Beginn (ISO oder YYYY-MM-DD)" }) }),
          end: arg.required({
            description: t({ en: "End (ISO or YYYY-MM-DD, inclusive)", de: "Ende (ISO oder YYYY-MM-DD, einschließlich)" }),
          }),
        },
        flags: {
          space: flag.string({ description: t({ en: "Only this space", de: "Nur dieser Space" }) }),
          exclude: flag.string({
            valueLabel: "item",
            description: t({ en: "Item to ignore, e.g. the one being moved", de: "Zu ignorierender Eintrag, z. B. der verschobene" }),
          }),
        },
        examples: ["cld spaces overlap 2026-10-20T10:00:00Z 2026-10-20T11:00:00Z --exclude Item01"],
        async run({ ctx, args, flags }) {
          const range = calendarRange(args.start, args.end);
          const space = flags.space ? await resolveSpace(ctx, flags.space) : null;
          const excludeItemId = flags.exclude ? (await resolveItem(ctx, flags.exclude)).id : undefined;
          const items = (await readApi<OverlapItem[]>(ctx, withQuery(api("/calendar/overlap"), { ...range, excludeItemId }))).filter(
            (item) => !space || item.spaceId === space.id,
          );
          printRows(ctx, items, items, [
            { key: "itemId", label: "ID" },
            { key: "spaceName", label: "SPACE" },
            { key: "title", label: t({ en: "TITLE", de: "TITEL" }) },
            { key: "startsAt", label: t({ en: "START", de: "BEGINN" }) },
            { key: "endsAt", label: t({ en: "END", de: "ENDE" }) },
          ]);
        },
      }),
      command("invitation context", {
        summary: t({ en: "Show Mail senders and attendees for an event", de: "Mail-Absender und Teilnehmende eines Termins zeigen" }),
        args: itemArg,
        async run({ ctx, args }) {
          const value = await readApi<EventInvitationContext>(ctx, itemApi(await resolveItem(ctx, args.item), "/invitation-context"));
          if (printStructured(ctx, value)) return;
          ctx.table(
            value.mailboxes.flatMap((mailbox) =>
              mailbox.identities.map((identity) => ({
                mailbox: mailbox.name,
                from: identity.from.address,
                identity: identity.id,
                id: mailbox.id,
              })),
            ),
            [
              { key: "mailbox", label: t({ en: "MAILBOX", de: "POSTFACH" }) },
              { key: "from", label: t({ en: "FROM", de: "VON" }) },
              { key: "identity", label: t({ en: "IDENTITY", de: "IDENTITÄT" }) },
              { key: "id", label: "ID" },
            ],
          );
          if (value.attendees.length > 0)
            ctx.print(`${t({ en: "Attendees", de: "Teilnehmende" })}: ${value.attendees.map((attendee) => attendee.address).join(", ")}`);
          if (value.lastDelivery)
            ctx.print(
              `${t({ en: "Latest delivery", de: "Letzte Zustellung" })}: ${value.lastDelivery.state} ${value.lastDelivery.method} #${value.lastDelivery.sequence}${
                value.lastDelivery.errorMessage ? ` · ${value.lastDelivery.errorMessage}` : ""
              }`,
            );
        },
      }),
      command("invitation draft", {
        summary: t({
          en: "Create an editable Mail invitation or cancellation draft",
          de: "Einen bearbeitbaren Mail-Entwurf für Einladung oder Absage anlegen",
        }),
        args: itemArg,
        flags: {
          mailbox: flag.string({
            required: true,
            description: t({ en: "Writable Mail mailbox ID", de: "Beschreibbare Mail-Postfach-ID" }),
          }),
          identity: flag.string({
            required: true,
            description: t({ en: "Verified sender identity ID", de: "Verifizierte Absenderidentitäts-ID" }),
          }),
          to: flag.stringList({ description: t({ en: "Attendee address; repeatable", de: "Teilnehmeradresse; wiederholbar" }) }),
          cancel: flag.boolean({ description: t({ en: "Create a cancellation", de: "Eine Absage anlegen" }) }),
          idempotencyKey: flag.string({
            name: "idempotency-key",
            description: t({ en: "Stable retry key", de: "Stabiler Wiederholungsschlüssel" }),
          }),
        },
        async run({ ctx, args, flags }) {
          if (flags.to.length === 0)
            throw new Error(t({ en: "Pass at least one --to attendee.", de: "Übergib mindestens eine --to-Adresse." }));
          const item = await resolveItem(ctx, args.item);
          const value = await send<EventInvitationDraft>(ctx, "POST", itemApi(item, "/invitation-draft"), {
            idempotencyKey: flags.idempotencyKey ?? crypto.randomUUID(),
            mailboxId: flags.mailbox,
            senderIdentityId: flags.identity,
            attendees: flags.to.map((address) => ({ name: null, address })),
            method: flags.cancel ? "cancel" : "request",
          });
          if (!printStructured(ctx, value))
            ctx.print(`${t({ en: "Created Mail draft", de: "Mail-Entwurf angelegt" })} ${value.draftId}: ${value.href}`);
        },
      }),
      ...spaceAccessCommands,
    ],
  });

  async function resolveAttachment(ctx: CloudCliContext, item: SpaceItem, ref: string): Promise<SpaceItemAttachment> {
    const attachments = await readApi<SpaceItemAttachment[]>(ctx, itemApi(item, "/attachments"));
    const matches = attachments.filter((attachment) => attachment.id === ref || attachment.filename === ref);
    if (matches.length === 1) return matches[0]!;
    throw new Error(
      matches.length > 1
        ? t(
            cliAmbiguityText({
              value: ref,
              resources: { en: "attachments", de: "Anhängen" },
              candidates: matches.map((attachment) => ({ path: attachment.filename, id: attachment.id })),
            }),
          )
        : t({ en: `Attachment "${ref}" was not found on ${item.title}.`, de: `Anhang „${ref}“ gibt es bei ${item.title} nicht.` }),
    );
  }
}

const module = spacesCommands();
export default {
  ...module,
  help: (locale?: string) => spacesCommands(locale).help!(),
  run: (ctx: CloudCliContext) => spacesCommands(ctx.options.locale).run(ctx),
};
