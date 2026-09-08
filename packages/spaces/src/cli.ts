import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Paginated } from "@k2b/stdlib";
import {
  arg,
  type CloudCliContext,
  type CloudCliFlags,
  command,
  confirmFlag,
  createAccessCommands,
  defineCliCommands,
  flag,
  printRows as printJsonOrTable,
  printStructured,
} from "@valentinkolb/cloud/cli";
import type { AccessEntry, PermissionLevel, Principal } from "@valentinkolb/cloud/contracts";
import type {
  CalendarItem,
  ItemListResult,
  ItemStatus,
  ItemType,
  OverlapItem,
  Priority,
  Space,
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

const SPACE_DEFAULT_KEY = "spaces.space";

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
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return values
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const booleanFlag = (flags: CloudCliFlags, ...names: string[]): boolean => names.some((name) => flags[name] === true);

const numberFlag = (flags: CloudCliFlags, ...names: string[]): number | undefined => {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed)) return parsed;
    }
  }
  return undefined;
};

const requireArg = (args: string[], index: number, label: string): string => {
  const value = args[index];
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
};

const parsePositiveInt = (value: string | undefined, fallback: number, label: string): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
};

const isResourceId = (value: string): boolean => /^[0-9A-Za-z]{6}$/.test(value);
const isHttpStatus = (error: unknown, status: number): boolean => error instanceof Error && error.message.startsWith(`${status} `);

const readInputContent = async (ctx: CloudCliContext, flagName = "content", required = true): Promise<string | undefined> => {
  const literal = stringFlag(ctx.flags, flagName);
  const file = stringFlag(ctx.flags, "file", "f");
  const stdin = booleanFlag(ctx.flags, "stdin");
  const sources = [literal !== undefined, file !== undefined, stdin].filter(Boolean).length;
  if (sources > 1) throw new Error(`Pass only one of --${flagName}, --file, or --stdin.`);
  if (literal !== undefined) return literal;
  if (file) return readFile(file, "utf8");
  if (stdin) return Bun.stdin.text();
  if (required) throw new Error(`Missing content. Pass --${flagName}, --file, or --stdin.`);
  return undefined;
};

const apiPath = (path = "") => `/api/spaces${path === "/" ? "" : path}`;

const readApi = async <T>(ctx: CloudCliContext, path: string, init?: RequestInit): Promise<T> =>
  ctx.readJson<T>(await ctx.fetch(apiPath(path), init));

const attachmentApiPath = (spaceId: string, itemId: string, suffix = "") =>
  apiPath(`/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}/attachments${suffix}`);

const listAttachments = (ctx: CloudCliContext, spaceId: string, itemId: string) =>
  readApi<SpaceItemAttachment[]>(ctx, `/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}/attachments`);

const resolveAttachmentRef = async (ctx: CloudCliContext, spaceId: string, itemId: string, ref: string) => {
  const attachments = await listAttachments(ctx, spaceId, itemId);
  const matches = attachments.filter((attachment) => attachment.id === ref || attachment.filename === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Attachment "${ref}" is ambiguous. Use one of: ${matches.map((attachment) => attachment.id).join(", ")}`);
  }
  throw new Error(`Attachment "${ref}" was not found.`);
};

const jsonRequest = (method: string, value: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

const listSpaces = async (ctx: CloudCliContext): Promise<Space[]> => {
  const spaces = await readApi<Space[]>(ctx, "/");
  const query = stringFlag(ctx.flags, "q", "query")?.toLowerCase();
  if (!query) return spaces;
  return spaces.filter((space) => space.name.toLowerCase().includes(query) || space.description?.toLowerCase().includes(query));
};

const formatSpaceCandidates = (items: Space[]): string =>
  items
    .slice(0, 5)
    .map((item) => `${item.name} (${item.id})`)
    .join(", ");

const formatItemCandidates = (items: SpaceItem[]): string =>
  items
    .slice(0, 5)
    .map((item) => `${item.title} (${item.id})`)
    .join(", ");

const resolveSpaceRef = async (ctx: CloudCliContext, ref: string): Promise<SpaceDetail> => {
  if (isResourceId(ref)) {
    try {
      return await readApi<SpaceDetail>(ctx, `/${ref}`);
    } catch (error) {
      if (!isHttpStatus(error, 404)) throw error;
    }
  }

  const spaces = await readApi<Space[]>(ctx, "/");
  const matches = spaces.filter((space) => space.name === ref);
  if (matches.length === 1) return readApi<SpaceDetail>(ctx, `/${matches[0]!.id}`);
  if (matches.length > 1) throw new Error(`Space "${ref}" is ambiguous. Use one of: ${formatSpaceCandidates(matches)}`);
  const candidates = formatSpaceCandidates(spaces.filter((space) => space.name.toLowerCase().includes(ref.toLowerCase())).slice(0, 5));
  throw new Error(
    candidates
      ? `Space "${ref}" was not found by id or exact name. Similar matches: ${candidates}`
      : `Space "${ref}" was not found by id or exact name.`,
  );
};

const requireDefaultSpaceRef = async (ctx: CloudCliContext): Promise<string> => {
  const ref = await ctx.getDefault(SPACE_DEFAULT_KEY);
  if (!ref) throw new Error("Missing space. Pass --space <space> or run `cld spaces use <space>`.");
  return ref;
};

const resolveSpaceArg = async (
  ctx: CloudCliContext,
  args: string[],
  requiredTrailingArgs: number,
): Promise<{ spaceRef: string; rest: string[] }> => {
  const flagged = stringFlag(ctx.flags, "space");
  if (flagged) return { spaceRef: flagged, rest: args };
  if (args.length > requiredTrailingArgs) return { spaceRef: requireArg(args, 0, "space"), rest: args.slice(1) };
  return { spaceRef: await requireDefaultSpaceRef(ctx), rest: args };
};

const resolveItemRef = async (ctx: CloudCliContext, spaceId: string, ref: string): Promise<SpaceItem> => {
  if (isResourceId(ref)) {
    try {
      return await readApi<SpaceItem>(ctx, `/${spaceId}/items/${ref}`);
    } catch (error) {
      if (!isHttpStatus(error, 404)) throw error;
    }
  }

  const payload = await readApi<ItemListResult>(
    ctx,
    `/${spaceId}/items/filter`,
    jsonRequest("POST", {
      type: "all",
      status: "all",
      search: ref,
      sort: "updated",
      sortDesc: true,
      groupBy: "none",
      page: 1,
      pageSize: 50,
    }),
  );
  const matches = payload.items.filter((item) => item.title === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Item "${ref}" is ambiguous. Use one of: ${formatItemCandidates(matches)}`);
  const candidates = formatItemCandidates(payload.items);
  throw new Error(
    candidates
      ? `Item "${ref}" was not found by id or exact title. Similar matches: ${candidates}`
      : `Item "${ref}" was not found by id or exact title.`,
  );
};

const resolveColumnId = (space: SpaceDetail, ref: string): string => {
  if (isResourceId(ref)) return ref;
  const matches = space.columns.filter((column) => column.name === ref);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1)
    throw new Error(`Column "${ref}" is ambiguous. Use one of: ${matches.map((column) => `${column.name} (${column.id})`).join(", ")}`);
  throw new Error(`Column "${ref}" was not found in ${space.name}.`);
};

const resolveTagIds = (space: SpaceDetail, refs: string[]): string[] =>
  refs.map((ref) => {
    if (isResourceId(ref)) return ref;
    const matches = space.tags.filter((tag) => tag.name === ref);
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1)
      throw new Error(`Tag "${ref}" is ambiguous. Use one of: ${matches.map((tag) => `${tag.name} (${tag.id})`).join(", ")}`);
    throw new Error(`Tag "${ref}" was not found in ${space.name}.`);
  });

const itemRows = (items: SpaceItem[], space?: SpaceDetail) =>
  items.map((item) => ({
    id: item.id,
    title: item.title,
    column: space?.columns.find((column) => column.id === item.columnId)?.name ?? item.columnId,
    status: item.completedAt ? "completed" : "active",
    priority: item.priority ?? "",
    deadline: item.deadline ?? "",
    estimateMinutes: item.estimatedDurationMinutes ?? "",
    blockers: item.activeBlockerCount || "",
    updatedAt: item.updatedAt,
  }));

const spaceRows = (items: Space[]) =>
  items.map((space) => ({
    id: space.id,
    name: space.name,
    color: space.color,
    updatedAt: space.updatedAt,
  }));

const commentRows = (items: SpaceComment[]) =>
  items.map((comment) => ({
    id: comment.id,
    author: comment.userName ?? comment.userId ?? "",
    content: comment.content.replace(/\s+/g, " ").slice(0, 80),
    createdAt: comment.createdAt,
  }));

const attachmentRows = (items: SpaceItemAttachment[]) =>
  items.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    type: attachment.mimeType,
    bytes: attachment.sizeBytes,
    createdAt: attachment.createdAt,
  }));

const calendarRows = (items: CalendarItem[]) =>
  items.map((item) => ({
    id: item.id,
    space: item.spaceName,
    title: item.title,
    startsAt: item.startsAt ?? "",
    endsAt: item.endsAt ?? "",
    deadline: item.deadline ?? "",
  }));

const overlapRows = (items: OverlapItem[]) =>
  items.map((item) => ({
    id: item.itemId,
    space: item.spaceName,
    title: item.title,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
  }));

const itemType = (value: string | undefined): ItemType => {
  if (value === "task" || value === "event" || value === "all") return value;
  if (value) throw new Error("--type must be all, task, or event.");
  return "all";
};

const itemStatus = (value: string | undefined): ItemStatus => {
  if (value === "active" || value === "completed" || value === "all") return value;
  if (value) throw new Error("--status must be active, completed, or all.");
  return "active";
};

const priority = (value: string | undefined): Priority | undefined => {
  if (!value) return undefined;
  if (value === "low" || value === "medium" || value === "high" || value === "urgent") return value;
  throw new Error("--priority must be low, medium, high, or urgent.");
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const normalizeDateTime = (value: string | undefined, label: string, endOfDay = false): string | undefined => {
  if (!value) return undefined;
  if (DATE_ONLY_PATTERN.test(value)) return `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be an ISO datetime or YYYY-MM-DD date.`);
  return date.toISOString();
};

const optionalSpaceArgs = {
  args: arg.rest({ valueLabel: "space-or-args", description: "Optional leading space followed by command arguments." }),
};

const spaceFlag = {
  space: flag.string({ description: "Space id or exact name" }),
};

const spaceAccessCommands = createAccessCommands({
  resourceLabel: "space",
  resourceArgLabel: "space",
  resourceArgDescription: "Optional space id or exact name. If omitted, the default from `cld spaces use` is used.",
  resolveResource: async (ctx, args) => {
    const { spaceRef, rest } = await resolveSpaceArg(ctx, args, 0);
    if (rest.length > 0) throw new Error(`Unexpected space access arguments: ${rest.join(" ")}`);
    const space = await resolveSpaceRef(ctx, spaceRef);
    return {
      id: space.id,
      label: `${space.name} (${space.id})`,
    };
  },
  list: async (ctx, space) => readApi<AccessEntry[]>(ctx, `/${space.id}/access`),
  grant: async (ctx, space, principal: Principal, permission: PermissionLevel) =>
    readApi<AccessEntry>(ctx, `/${space.id}/access`, jsonRequest("POST", { principal, permission })),
  update: async (ctx, space, accessId, permission) => {
    await readApi<unknown>(ctx, `/${space.id}/access/${accessId}`, jsonRequest("PATCH", { permission }));
  },
  revoke: async (ctx, space, accessId) => {
    await readApi<unknown>(ctx, `/${space.id}/access/${accessId}`, { method: "DELETE" });
  },
  examples: {
    list: ['cld spaces access list "Roadmap"', "cld spaces access list --include-service-accounts"],
    grant: [
      'cld spaces access grant "Roadmap" --user valentin.kolb --permission read',
      'cld spaces access grant "Roadmap" --group "Editors" --permission write',
      'cld spaces access grant "Roadmap" --authenticated --permission read',
    ],
    set: [
      'cld spaces access set "Roadmap" --user valentin.kolb --permission admin',
      "cld spaces access set --access-id 00000000-0000-4000-8000-000000000000 --permission write",
    ],
    revoke: [
      'cld spaces access revoke "Roadmap" --user valentin.kolb --yes',
      "cld spaces access revoke --access-id 00000000-0000-4000-8000-000000000000 --yes",
    ],
    searchPrincipals: [
      "cld spaces access search-principals val --kind user,group",
      'cld spaces access search-principals "Editors" --kind group',
    ],
  },
});

const contentFlags = {
  content: flag.string({ description: "Content text" }),
  file: flag.string({ aliases: ["f"], description: "Read content from file" }),
  stdin: flag.boolean({ description: "Read content from stdin" }),
};

const itemMutationFlags = {
  ...spaceFlag,
  column: flag.string({ description: "Column id or exact name" }),
  description: flag.string({ description: "Item description" }),
  file: flag.string({ aliases: ["f"], description: "Read description from file" }),
  stdin: flag.boolean({ description: "Read description from stdin" }),
  deadline: flag.string({ description: "Deadline as ISO datetime or YYYY-MM-DD" }),
  estimateMinutes: flag.int({
    name: "estimate-minutes",
    aliases: ["estimateMinutes"],
    min: 1,
    description: "Estimated task duration in minutes",
  }),
  startsAt: flag.string({ name: "starts-at", aliases: ["startsAt"], description: "Start time as ISO datetime or YYYY-MM-DD" }),
  endsAt: flag.string({ name: "ends-at", aliases: ["endsAt"], description: "End time as ISO datetime or YYYY-MM-DD" }),
  priority: flag.enum(["low", "medium", "high", "urgent"], { description: "Priority" }),
  tag: flag.stringList({ description: "Tag id or exact name. Repeatable." }),
  assignee: flag.stringList({ description: "Assignee user id. Repeatable." }),
};

const dateRangeFlags = {
  ...spaceFlag,
  from: flag.string({ required: true, description: "Start as ISO datetime or YYYY-MM-DD" }),
  to: flag.string({ required: true, description: "End as ISO datetime or YYYY-MM-DD" }),
};

export default defineCliCommands({
  name: "spaces",
  summary: "Inspect and update Spaces through the Spaces REST API.",
  groupSummaries: {
    access: "Manage direct access to spaces",
    checklist: "Manage task checklists",
    references: "Link Cloud resources to items",
    invitation: "Prepare Mail invitations for Space events",
  },
  commands: [
    command("list", {
      summary: "List spaces",
      flags: {
        q: flag.string({ aliases: ["query"], description: "Filter by name or description" }),
      },
      run: async ({ ctx }) => {
        const spaces = await listSpaces(ctx);
        printJsonOrTable(ctx, spaces, spaceRows(spaces), [
          { key: "name", label: "NAME" },
          { key: "color", label: "COLOR" },
          { key: "updatedAt", label: "UPDATED" },
          { key: "id", label: "ID" },
        ]);
      },
    }),
    command("use", {
      summary: "Set the default space",
      args: {
        space: arg.required({ description: "Space id or exact name" }),
      },
      run: async ({ ctx, args }) => {
        const space = await resolveSpaceRef(ctx, args.space);
        await ctx.setDefault(SPACE_DEFAULT_KEY, space.id);
        if (!printStructured(ctx, { space, defaultSpace: space.id })) ctx.print(`Using space ${space.name} (${space.id}).`);
      },
    }),
    command("current", {
      summary: "Show the default space",
      run: async ({ ctx }) => {
        const spaceRef = await ctx.getDefault(SPACE_DEFAULT_KEY);
        if (!spaceRef) throw new Error("No default space configured. Run `cld spaces use <space>`.");
        const space = await resolveSpaceRef(ctx, spaceRef);
        if (!printStructured(ctx, { space, defaultSpace: space.id })) ctx.print(`${space.name} (${space.id})`);
      },
    }),
    command("get", {
      summary: "Show a space",
      args: {
        spaceArg: arg.optional({ valueLabel: "space", description: "Space id or exact name" }),
      },
      flags: spaceFlag,
      run: async ({ ctx, args }) => {
        const { spaceRef } = await resolveSpaceArg(ctx, args.spaceArg ? [args.spaceArg] : [], 0);
        const space = await resolveSpaceRef(ctx, spaceRef);
        if (!printStructured(ctx, space)) {
          ctx.print(`${space.name} (${space.id})`);
          if (space.description) ctx.print(space.description);
          ctx.print(`columns: ${space.columns.map((column) => column.name).join(", ") || "none"}`);
          ctx.print(`tags: ${space.tags.map((tag) => tag.name).join(", ") || "none"}`);
        }
      },
    }),
    command("create", {
      summary: "Create a space",
      args: {
        name: arg.required({ description: "Space name" }),
      },
      flags: {
        description: flag.string({ description: "Space description" }),
        color: flag.string({ description: "Space color" }),
        use: flag.boolean({ description: "Use the new space as default" }),
      },
      run: async ({ ctx, args }) => {
        const space = await readApi<Space>(
          ctx,
          "/",
          jsonRequest("POST", {
            name: args.name,
            description: stringFlag(ctx.flags, "description"),
            color: stringFlag(ctx.flags, "color") ?? "#3b82f6",
          }),
        );
        if (booleanFlag(ctx.flags, "use")) await ctx.setDefault(SPACE_DEFAULT_KEY, space.id);
        if (!printStructured(ctx, space))
          ctx.print(`Created ${space.name} (${space.id}).${booleanFlag(ctx.flags, "use") ? " Using it as default." : ""}`);
      },
    }),
    ...spaceAccessCommands,
    command("items", {
      summary: "List items in a space",
      args: optionalSpaceArgs,
      flags: {
        ...spaceFlag,
        q: flag.string({ aliases: ["query"], description: "Search query" }),
        status: flag.enum(["active", "completed", "all"], { default: "active", description: "Item status" }),
        type: flag.enum(["all", "task", "event"], { default: "all", description: "Item type" }),
        ready: flag.boolean({ description: "Open tasks without active blockers" }),
        blocked: flag.boolean({ description: "Open tasks with active blockers" }),
        assignedTo: flag.enum(["all", "assigned", "me", "unassigned"], { name: "assigned-to", description: "Assignment filter" }),
        assignee: flag.stringList({ description: "Assignee user IDs" }),
        priority: flag.stringList({ description: "Priorities: low, medium, high, urgent" }),
        column: flag.stringList({ description: "Workflow column IDs or names" }),
        tag: flag.stringList({ description: "Tag IDs or names" }),
        deadline: flag.enum(["all", "overdue", "today", "week", "none"], { description: "Deadline window" }),
        activity: flag.enum(["all", "inactive"], { description: "Activity filter" }),
        sort: flag.enum(["column", "priority", "deadline", "created", "updated", "title"], { default: "updated" }),
        ascending: flag.boolean({ description: "Sort ascending" }),
        page: flag.int({ min: 1, description: "Page number" }),
        pageSize: flag.int({ name: "page-size", aliases: ["page_size"], min: 1, description: "Items per page" }),
      },
      run: async ({ ctx, args }) => {
        const { spaceRef } = await resolveSpaceArg(ctx, args.args, 0);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const ready = booleanFlag(ctx.flags, "ready");
        const blocked = booleanFlag(ctx.flags, "blocked");
        if (ready && blocked) throw new Error("Pass only one of --ready or --blocked.");
        if ((ready || blocked) && (stringFlag(ctx.flags, "type") === "event" || stringFlag(ctx.flags, "status") === "completed"))
          throw new Error("--ready and --blocked select open tasks.");
        const payload = await readApi<ItemListResult>(
          ctx,
          `/${space.id}/items/filter`,
          jsonRequest("POST", {
            type: ready || blocked ? "task" : itemType(stringFlag(ctx.flags, "type")),
            status: ready || blocked ? "active" : itemStatus(stringFlag(ctx.flags, "status")),
            blocked: ready ? false : blocked ? true : undefined,
            assignedTo: stringFlag(ctx.flags, "assigned-to"),
            assigneeIds: stringFlags(ctx.flags, "assignee"),
            priority: stringFlags(ctx.flags, "priority"),
            columnIds: stringFlags(ctx.flags, "column").map((ref) => resolveColumnId(space, ref)),
            tagIds: resolveTagIds(space, stringFlags(ctx.flags, "tag")),
            deadlineFilter: stringFlag(ctx.flags, "deadline"),
            activity: stringFlag(ctx.flags, "activity"),
            search: stringFlag(ctx.flags, "q", "query"),
            sort: stringFlag(ctx.flags, "sort") ?? "updated",
            sortDesc: !booleanFlag(ctx.flags, "ascending"),
            groupBy: "none",
            page: parsePositiveInt(stringFlag(ctx.flags, "page"), 1, "--page"),
            pageSize: parsePositiveInt(stringFlag(ctx.flags, "page-size", "page_size"), 50, "--page-size"),
          }),
        );
        printJsonOrTable(ctx, payload, itemRows(payload.items, space), [
          { key: "title", label: "TITLE" },
          { key: "column", label: "COLUMN" },
          { key: "status", label: "STATUS" },
          { key: "priority", label: "PRIORITY" },
          { key: "deadline", label: "DEADLINE" },
          { key: "estimateMinutes", label: "ESTIMATE" },
          { key: "blockers", label: "BLOCKERS" },
          { key: "id", label: "ID" },
        ]);
      },
    }),
    command("item", {
      summary: "Show one space item",
      args: optionalSpaceArgs,
      flags: {
        ...spaceFlag,
        context: flag.boolean({ description: "Include work state, checklist, dependencies, references and a comments page" }),
        page: flag.int({ min: 1 }),
        pageSize: flag.int({ name: "page-size", min: 1, max: 100 }),
      },
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "item"));
        const attachments = item.startsAt || item.endsAt ? undefined : await listAttachments(ctx, space.id, item.id);
        if (booleanFlag(ctx.flags, "context")) {
          const base = `/${space.id}/items/${item.id}`;
          const page = numberFlag(ctx.flags, "page") ?? 1;
          const perPage = numberFlag(ctx.flags, "page-size") ?? 50;
          const [comments, references, work, checklist, blockers, blocks] = await Promise.all([
            readApi<Paginated<SpaceComment>>(ctx, `${base}/comments/page?page=${page}&per_page=${perPage}`),
            readApi<SpaceItemResourceReference[]>(ctx, `${base}/references`),
            attachments ? readApi<TaskWork>(ctx, `${base}/work`) : Promise.resolve(null),
            attachments ? readApi<SpaceTaskChecklistEntry[]>(ctx, `${base}/checklist`) : Promise.resolve([]),
            attachments ? readApi<SpaceTaskDependency[]>(ctx, `${base}/blockers`) : Promise.resolve([]),
            attachments
              ? readApi<Paginated<SpaceTaskDependent>>(ctx, `${base}/blocks/page?page=${page}&per_page=${perPage}`)
              : Promise.resolve(null),
          ]);
          const context = { ...item, attachments, work, checklist, blockers, blocks, references, comments };
          if (!printStructured(ctx, context)) ctx.print(JSON.stringify(context, null, 2));
          return;
        }
        const detail = attachments ? { ...item, attachments } : item;
        if (!printStructured(ctx, detail)) {
          ctx.print(`${item.title} (${item.id})`);
          if (item.description) ctx.print(item.description);
          ctx.print(`column: ${space.columns.find((column) => column.id === item.columnId)?.name ?? item.columnId}`);
          ctx.print(`status: ${item.completedAt ? "completed" : "active"}`);
          if (item.estimatedDurationMinutes) ctx.print(`estimate: ${item.estimatedDurationMinutes} minutes`);
          if (item.activeBlockerCount > 0) ctx.print(`blocked by: ${item.activeBlockerCount} active task(s)`);
          if (attachments?.length) ctx.print(`attachments: ${attachments.map((attachment) => attachment.filename).join(", ")}`);
        }
      },
    }),
    command("attachments", {
      summary: "List task attachments",
      args: optionalSpaceArgs,
      flags: spaceFlag,
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
        const attachments = await listAttachments(ctx, space.id, item.id);
        printJsonOrTable(ctx, attachments, attachmentRows(attachments), [
          { key: "filename", label: "FILE" },
          { key: "type", label: "TYPE" },
          { key: "bytes", label: "BYTES" },
          { key: "createdAt", label: "CREATED" },
          { key: "id", label: "ID" },
        ]);
      },
    }),
    command("add-attachment", {
      summary: "Upload a task attachment",
      args: optionalSpaceArgs,
      flags: {
        ...spaceFlag,
        file: flag.string({ required: true, description: "Local image file" }),
      },
      run: async ({ ctx, args, flags }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
        const path = flags.file;
        if (!path) throw new Error("Missing file. Pass --file <path>.");
        const file = Bun.file(path);
        if (!(await file.exists())) throw new Error(`File "${path}" was not found.`);
        const form = new FormData();
        form.set("file", file, basename(path));
        const attachment = await ctx.readJson<SpaceItemAttachment>(
          await ctx.fetch(attachmentApiPath(space.id, item.id), { method: "POST", body: form }),
        );
        if (!printStructured(ctx, attachment)) ctx.print(`Added ${attachment.filename} (${attachment.id}) to ${item.title}.`);
      },
    }),
    command("download-attachment", {
      summary: "Download a task attachment",
      args: optionalSpaceArgs,
      flags: {
        ...spaceFlag,
        output: flag.string({ aliases: ["out", "output-file"], description: "Destination file path" }),
      },
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 2);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
        const attachment = await resolveAttachmentRef(ctx, space.id, item.id, requireArg(rest, 1, "attachment"));
        const output = stringFlag(ctx.flags, "output", "out", "output-file") ?? attachment.filename;
        const response = await ctx.fetch(
          attachmentApiPath(space.id, item.id, `/${encodeURIComponent(attachment.id)}/content?download=true`),
        );
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        await Bun.write(output, response);
        if (!printStructured(ctx, { attachment, output })) ctx.print(`Saved ${attachment.filename} to ${output}.`);
      },
    }),
    command("delete-attachment", {
      summary: "Delete a task attachment",
      args: optionalSpaceArgs,
      flags: { ...spaceFlag, yes: confirmFlag("Delete this attachment") },
      run: async ({ ctx, args }) => {
        if (!booleanFlag(ctx.flags, "yes")) throw new Error("Refusing to delete an attachment without --yes.");
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 2);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
        const attachment = await resolveAttachmentRef(ctx, space.id, item.id, requireArg(rest, 1, "attachment"));
        const result = await ctx.readJson<{ message: string }>(
          await ctx.fetch(attachmentApiPath(space.id, item.id, `/${encodeURIComponent(attachment.id)}`), { method: "DELETE" }),
        );
        if (!printStructured(ctx, { ...result, attachment })) ctx.print(result.message);
      },
    }),
    command("invitation context", {
      summary: "Show Mail senders and recipients for a Space event",
      args: optionalSpaceArgs,
      flags: spaceFlag,
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "event"));
        const value = await readApi<EventInvitationContext>(ctx, `/${space.id}/items/${item.id}/invitation-context`);
        if (printStructured(ctx, value)) return;
        printJsonOrTable(
          ctx,
          value.mailboxes,
          value.mailboxes.flatMap((mailbox) =>
            mailbox.identities.map((identity) => ({
              name: mailbox.name,
              from: identity.from.address,
              identity: identity.id,
              id: mailbox.id,
            })),
          ),
          [
            { key: "name", label: "MAILBOX" },
            { key: "from", label: "FROM" },
            { key: "identity", label: "IDENTITY" },
            { key: "id", label: "ID" },
          ],
        );
        if (value.attendees.length > 0) ctx.print(`Attendees: ${value.attendees.map((attendee) => attendee.address).join(", ")}`);
        if (value.lastDelivery) {
          ctx.print(
            `Latest delivery: ${value.lastDelivery.state} ${value.lastDelivery.method} sequence ${value.lastDelivery.sequence}${
              value.lastDelivery.errorMessage ? ` · ${value.lastDelivery.errorMessage}` : ""
            }`,
          );
        }
      },
    }),
    command("invitation draft", {
      summary: "Create an editable Mail invitation or cancellation draft",
      args: optionalSpaceArgs,
      flags: {
        ...spaceFlag,
        mailbox: flag.string({ required: true, description: "Writable Mail mailbox id" }),
        identity: flag.string({ required: true, description: "Verified Mail sender identity id" }),
        to: flag.stringList({ description: "Attendee email address. Repeatable." }),
        cancel: flag.boolean({ description: "Create a cancellation instead of a request/update" }),
        idempotencyKey: flag.string({ name: "idempotency-key", description: "Stable retry key" }),
      },
      run: async ({ ctx, args, flags }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "event"));
        if (flags.to.length === 0) throw new Error("Pass at least one --to attendee.");
        const value = await readApi<EventInvitationDraft>(
          ctx,
          `/${space.id}/items/${item.id}/invitation-draft`,
          jsonRequest("POST", {
            idempotencyKey: flags.idempotencyKey ?? crypto.randomUUID(),
            mailboxId: flags.mailbox,
            senderIdentityId: flags.identity,
            attendees: flags.to.map((address) => ({ name: null, address })),
            method: flags.cancel ? "cancel" : "request",
          }),
        );
        if (!printStructured(ctx, value)) ctx.print(`Created Mail draft ${value.draftId}: ${value.href}`);
      },
    }),
    command("add-item", {
      summary: "Create an item in a space",
      args: optionalSpaceArgs,
      flags: itemMutationFlags,
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const column = stringFlag(ctx.flags, "column");
        if (!column) throw new Error("Missing column. Pass --column <column>.");
        const columnId = resolveColumnId(space, column);
        const item = await readApi<SpaceItem>(
          ctx,
          `/${space.id}/items`,
          jsonRequest("POST", {
            columnId,
            title: requireArg(rest, 0, "item title"),
            description: await readInputContent(ctx, "description", false),
            startsAt: normalizeDateTime(stringFlag(ctx.flags, "starts-at", "startsAt"), "--starts-at"),
            endsAt: normalizeDateTime(stringFlag(ctx.flags, "ends-at", "endsAt"), "--ends-at", true),
            deadline: normalizeDateTime(stringFlag(ctx.flags, "deadline"), "--deadline", true),
            estimatedDurationMinutes: numberFlag(ctx.flags, "estimate-minutes", "estimateMinutes"),
            priority: priority(stringFlag(ctx.flags, "priority")),
            assigneeIds: stringFlags(ctx.flags, "assignee"),
            tagIds: resolveTagIds(space, stringFlags(ctx.flags, "tag")),
          }),
        );
        if (!printStructured(ctx, item)) ctx.print(`Created ${item.title} (${item.id}).`);
      },
    }),
    command("update-item", {
      summary: "Update an item in a space",
      args: optionalSpaceArgs,
      flags: {
        ...itemMutationFlags,
        title: flag.string({ description: "Item title" }),
        clearEstimate: flag.boolean({ name: "clear-estimate", description: "Clear the estimated duration" }),
        clearAssignees: flag.boolean({ name: "clear-assignees", description: "Remove all assignees" }),
        clearTags: flag.boolean({ name: "clear-tags", description: "Remove all tags" }),
      },
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "item"));
        const nextPriority = priority(stringFlag(ctx.flags, "priority"));
        const payload: Record<string, unknown> = {
          title: stringFlag(ctx.flags, "title"),
          description: await readInputContent(ctx, "description", false),
          startsAt: normalizeDateTime(stringFlag(ctx.flags, "starts-at", "startsAt"), "--starts-at"),
          endsAt: normalizeDateTime(stringFlag(ctx.flags, "ends-at", "endsAt"), "--ends-at", true),
          deadline: normalizeDateTime(stringFlag(ctx.flags, "deadline"), "--deadline", true),
          estimatedDurationMinutes: booleanFlag(ctx.flags, "clear-estimate")
            ? null
            : numberFlag(ctx.flags, "estimate-minutes", "estimateMinutes"),
          priority: nextPriority,
        };
        const column = stringFlag(ctx.flags, "column");
        if (column) payload.columnId = resolveColumnId(space, column);
        const assignees = stringFlags(ctx.flags, "assignee");
        if (assignees.length && booleanFlag(ctx.flags, "clear-assignees"))
          throw new Error("Pass --assignee or --clear-assignees, not both.");
        if (assignees.length > 0 || booleanFlag(ctx.flags, "clear-assignees")) payload.assigneeIds = assignees;
        const tags = stringFlags(ctx.flags, "tag");
        if (tags.length && booleanFlag(ctx.flags, "clear-tags")) throw new Error("Pass --tag or --clear-tags, not both.");
        if (tags.length > 0 || booleanFlag(ctx.flags, "clear-tags")) payload.tagIds = resolveTagIds(space, tags);

        const json = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
        if (Object.keys(json).length === 0) throw new Error("No item fields to update.");

        const updated = await readApi<SpaceItem>(ctx, `/${space.id}/items/${item.id}`, jsonRequest("PATCH", json));
        if (!printStructured(ctx, updated)) ctx.print(`Updated ${updated.title} (${updated.id}).`);
      },
    }),
    command("blockers", {
      summary: "List tasks blocking one task",
      args: optionalSpaceArgs,
      flags: spaceFlag,
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
        const blockers = await readApi<SpaceTaskDependency[]>(ctx, `/${space.id}/items/${item.id}/blockers`);
        printJsonOrTable(
          ctx,
          blockers,
          blockers.map((dependency) => ({
            title: dependency.blocker.title,
            status: dependency.blocker.completedAt ? "completed" : "active",
            id: dependency.blocker.id,
          })),
          [
            { key: "title", label: "BLOCKER" },
            { key: "status", label: "STATUS" },
            { key: "id", label: "ID" },
          ],
        );
      },
    }),
    command("blocks", {
      summary: "List tasks blocked by one task",
      args: optionalSpaceArgs,
      flags: { ...spaceFlag, page: flag.int({ min: 1 }), pageSize: flag.int({ name: "page-size", min: 1, max: 100 }) },
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
        const blockedTasks = await readApi<Paginated<SpaceTaskDependent>>(
          ctx,
          `/${space.id}/items/${item.id}/blocks/page?page=${numberFlag(ctx.flags, "page") ?? 1}&per_page=${numberFlag(ctx.flags, "page-size") ?? 50}`,
        );
        printJsonOrTable(
          ctx,
          blockedTasks,
          blockedTasks.items.map((dependency) => ({
            title: dependency.dependent.title,
            status: dependency.dependent.completedAt ? "completed" : "blocked",
            id: dependency.dependent.id,
          })),
          [
            { key: "title", label: "TASK" },
            { key: "status", label: "STATUS" },
            { key: "id", label: "ID" },
          ],
        );
        if (ctx.options.output === "text" && blockedTasks.hasNext)
          ctx.print(`More dependent tasks: --page ${blockedTasks.page + 1} --page-size ${blockedTasks.perPage}`);
      },
    }),
    command("block", {
      summary: "Add a task blocker",
      args: optionalSpaceArgs,
      flags: spaceFlag,
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 2);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
        const blocker = await resolveItemRef(ctx, space.id, requireArg(rest, 1, "blocker task"));
        const dependency = await readApi<SpaceTaskDependency>(
          ctx,
          `/${space.id}/items/${item.id}/blockers`,
          jsonRequest("POST", { blockerItemId: blocker.id }),
        );
        if (!printStructured(ctx, dependency)) ctx.print(`${item.title} is blocked by ${dependency.blocker.title}.`);
      },
    }),
    command("unblock", {
      summary: "Remove a task blocker",
      args: optionalSpaceArgs,
      flags: spaceFlag,
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 2);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
        const blocker = await resolveItemRef(ctx, space.id, requireArg(rest, 1, "blocker task"));
        await readApi<unknown>(ctx, `/${space.id}/items/${item.id}/blockers`, jsonRequest("DELETE", { blockerItemId: blocker.id }));
        if (!printStructured(ctx, { itemId: item.id, blockerItemId: blocker.id, removed: true })) {
          ctx.print(`Removed ${blocker.title} as a blocker of ${item.title}.`);
        }
      },
    }),
    ...(["done", "reopen"] as const).map((action) =>
      command(action, {
        summary: action === "done" ? "Mark an item completed" : "Reopen a completed item",
        args: optionalSpaceArgs,
        flags: {
          ...spaceFlag,
          result: flag.string({ description: "Completion result including verification" }),
          file: flag.string({ description: "Read result from file" }),
          stdin: flag.boolean({ description: "Read result from stdin" }),
          commit: flag.string({ description: "Optional commit SHA; requires a result" }),
          claimId: flag.string({ name: "claim-id", description: "Current worker claim ID" }),
        },
        run: async ({ ctx, args }) => {
          const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
          const space = await resolveSpaceRef(ctx, spaceRef);
          const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "item"));
          const updated = await readApi<SpaceItem>(
            ctx,
            `/${space.id}/items/${item.id}/completed`,
            jsonRequest("POST", {
              completed: action === "done",
              result: await readInputContent(ctx, "result", false),
              commit: stringFlag(ctx.flags, "commit"),
              claimId: stringFlag(ctx.flags, "claim-id"),
            }),
          );
          if (!printStructured(ctx, updated))
            ctx.print(`${action === "done" ? "Completed" : "Reopened"} ${updated.title} (${updated.id}).`);
        },
      }),
    ),
    command("comments", {
      summary: "List item comments",
      args: optionalSpaceArgs,
      flags: { ...spaceFlag, page: flag.int({ min: 1 }), pageSize: flag.int({ name: "page-size", min: 1, max: 100 }) },
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "item"));

        const page = numberFlag(ctx.flags, "page") ?? 1;
        const perPage = numberFlag(ctx.flags, "page-size") ?? 50;
        const comments = await readApi<Paginated<SpaceComment>>(
          ctx,
          `/${space.id}/items/${item.id}/comments/page?page=${page}&per_page=${perPage}`,
        );
        printJsonOrTable(ctx, comments, commentRows(comments.items), [
          { key: "author", label: "AUTHOR" },
          { key: "content", label: "CONTENT" },
          { key: "createdAt", label: "CREATED" },
          { key: "id", label: "ID" },
        ]);
        if (ctx.options.output === "text" && comments.hasNext)
          ctx.print(`More comments: --page ${comments.page + 1} --page-size ${comments.perPage}`);
      },
    }),
    command("comment", {
      summary: "Create an item comment",
      args: optionalSpaceArgs,
      flags: {
        ...spaceFlag,
        ...contentFlags,
      },
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "item"));
        const content = await readInputContent(ctx);
        const comment = await readApi<SpaceComment>(
          ctx,
          `/${space.id}/items/${item.id}/comments`,
          jsonRequest("POST", { content: content ?? "" }),
        );
        if (!printStructured(ctx, comment)) ctx.print(`Created comment ${comment.id}.`);
      },
    }),

    command("work", {
      summary: "Read current claim, progress and completion result",
      args: optionalSpaceArgs,
      flags: spaceFlag,
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
        const work = await readApi<TaskWork>(ctx, `/${space.id}/items/${item.id}/work`);
        if (!printStructured(ctx, work)) ctx.print(JSON.stringify(work, null, 2));
      },
    }),
    ...(["claim", "release", "progress"] as const).map((operation) =>
      command(operation, {
        summary:
          operation === "claim"
            ? "Claim one open unblocked task for a worker"
            : operation === "release"
              ? "Release your current task claim"
              : "Save a progress and handoff note",
        args: optionalSpaceArgs,
        flags: {
          ...spaceFlag,
          ...(operation === "progress" ? contentFlags : {}),
          ...(operation === "release" ? { force: flag.boolean({ description: "Admin recovery of the exact observed claim" }) } : {}),
          claimId: flag.string({
            name: "claim-id",
            description: "Worker-generated UUID; required for claim/release, and progress when claimed",
          }),
        },
        run: async ({ ctx, args }) => {
          const claimId = stringFlag(ctx.flags, "claim-id");
          if (operation !== "progress" && !claimId)
            throw new Error("Pass --claim-id <worker-generated UUID>. Reuse it only for retries of this claim.");
          const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
          const space = await resolveSpaceRef(ctx, spaceRef);
          const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
          const work = await readApi<TaskWork>(
            ctx,
            `/${space.id}/items/${item.id}/${operation}`,
            jsonRequest("POST", {
              claimId,
              ...(operation === "release" ? { force: booleanFlag(ctx.flags, "force") } : {}),
              ...(operation === "progress" ? { content: await readInputContent(ctx) } : {}),
            }),
          );
          if (!printStructured(ctx, work)) ctx.print(JSON.stringify(work, null, 2));
        },
      }),
    ),
    command("activity", {
      summary: "Read a task activity page including previous progress and results",
      args: optionalSpaceArgs,
      flags: {
        ...spaceFlag,
        cursor: flag.string({ description: "Next cursor from the preceding page" }),
        limit: flag.int({ min: 1, max: 100 }),
      },
      run: async ({ ctx, args }) => {
        const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
        const space = await resolveSpaceRef(ctx, spaceRef);
        const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
        const query = new URLSearchParams({ limit: String(numberFlag(ctx.flags, "limit") ?? 30) });
        const cursor = stringFlag(ctx.flags, "cursor");
        if (cursor) query.set("cursor", cursor);
        const result = await readApi<unknown>(ctx, `/${space.id}/items/${item.id}/activity?${query}`);
        if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
      },
    }),
    ...(["list", "add", "update", "delete"] as const).map((operation) =>
      command(`checklist ${operation}`, {
        summary: `${operation} task checklist entries`,
        args: optionalSpaceArgs,
        flags: {
          ...spaceFlag,
          label: flag.string({ description: "Entry label" }),
          completed: flag.boolean({ description: "Mark the entry completed" }),
          reopen: flag.boolean({ description: "Mark the entry incomplete" }),
          ...confirmFlag,
        },
        run: async ({ ctx, args }) => {
          if (operation === "delete" && !booleanFlag(ctx.flags, "yes")) throw new Error("Pass --yes to delete the checklist entry.");
          const completed = booleanFlag(ctx.flags, "completed");
          const reopen = booleanFlag(ctx.flags, "reopen");
          if (completed && reopen) throw new Error("Pass only one of --completed or --reopen.");
          const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, operation === "update" || operation === "delete" ? 2 : 1);
          const space = await resolveSpaceRef(ctx, spaceRef);
          const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "task"));
          const entry = operation === "update" || operation === "delete" ? `/${encodeURIComponent(requireArg(rest, 1, "entry ID"))}` : "";
          const method = operation === "list" ? undefined : operation === "add" ? "POST" : operation === "update" ? "PATCH" : "DELETE";
          const result = await readApi<unknown>(
            ctx,
            `/${space.id}/items/${item.id}/checklist${entry}`,
            method
              ? jsonRequest(method, {
                  label: stringFlag(ctx.flags, "label"),
                  ...(operation === "update" && (completed || reopen) ? { completed } : {}),
                })
              : undefined,
          );
          if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
        },
      }),
    ),
    ...(["list", "add", "remove"] as const).map((operation) =>
      command(`references ${operation}`, {
        summary: `${operation} Cloud resource references on an item`,
        args: optionalSpaceArgs,
        flags: {
          ...spaceFlag,
          type: flag.string({ description: "Cloud resource type, e.g. notebooks.note" }),
          id: flag.string({ description: "Resource ID" }),
          label: flag.string({ description: "Display label" }),
          ...confirmFlag,
        },
        run: async ({ ctx, args }) => {
          if (operation === "remove" && !booleanFlag(ctx.flags, "yes")) throw new Error("Pass --yes to remove the reference.");
          const { spaceRef, rest } = await resolveSpaceArg(ctx, args.args, 1);
          const space = await resolveSpaceRef(ctx, spaceRef);
          const item = await resolveItemRef(ctx, space.id, requireArg(rest, 0, "item"));
          const ref = { type: stringFlag(ctx.flags, "type"), id: stringFlag(ctx.flags, "id") };
          const result = await readApi<unknown>(
            ctx,
            `/${space.id}/items/${item.id}/references`,
            operation === "list"
              ? undefined
              : jsonRequest(operation === "add" ? "POST" : "DELETE", {
                  ref,
                  ...(operation === "add" ? { label: stringFlag(ctx.flags, "label") } : {}),
                }),
          );
          if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
        },
      }),
    ),

    command("calendar", {
      summary: "List calendar items",
      flags: dateRangeFlags,
      run: async ({ ctx }) => {
        const from = normalizeDateTime(stringFlag(ctx.flags, "from"), "--from");
        const to = normalizeDateTime(stringFlag(ctx.flags, "to"), "--to", true);
        if (!from || !to) throw new Error("Pass --from <iso|date> and --to <iso|date>.");
        const spaceRef = stringFlag(ctx.flags, "space") ?? (await ctx.getDefault(SPACE_DEFAULT_KEY));
        const space = spaceRef ? await resolveSpaceRef(ctx, spaceRef) : null;
        const items = await readApi<CalendarItem[]>(ctx, `/calendar?${new URLSearchParams({ from, to }).toString()}`);
        const filtered = space ? items.filter((item) => item.spaceId === space.id) : items;
        printJsonOrTable(ctx, filtered, calendarRows(filtered), [
          { key: "space", label: "SPACE" },
          { key: "title", label: "TITLE" },
          { key: "startsAt", label: "START" },
          { key: "endsAt", label: "END" },
          { key: "id", label: "ID" },
        ]);
      },
    }),
    command("overlap", {
      summary: "Find overlapping calendar items",
      flags: {
        ...dateRangeFlags,
        excludeItem: flag.string({ name: "exclude-item", aliases: ["excludeItemId"], description: "Item id to exclude" }),
      },
      run: async ({ ctx }) => {
        const from = normalizeDateTime(stringFlag(ctx.flags, "from"), "--from");
        const to = normalizeDateTime(stringFlag(ctx.flags, "to"), "--to", true);
        if (!from || !to) throw new Error("Pass --from <iso|date> and --to <iso|date>.");
        const spaceRef = stringFlag(ctx.flags, "space") ?? (await ctx.getDefault(SPACE_DEFAULT_KEY));
        const space = spaceRef ? await resolveSpaceRef(ctx, spaceRef) : null;
        const query = new URLSearchParams({ from, to });
        const excludeItemId = stringFlag(ctx.flags, "exclude-item", "excludeItemId");
        if (excludeItemId) query.set("excludeItemId", excludeItemId);
        const items = await readApi<OverlapItem[]>(ctx, `/calendar/overlap?${query.toString()}`);
        const filtered = space ? items.filter((item) => item.spaceId === space.id) : items;
        printJsonOrTable(ctx, filtered, overlapRows(filtered), [
          { key: "space", label: "SPACE" },
          { key: "title", label: "TITLE" },
          { key: "startsAt", label: "START" },
          { key: "endsAt", label: "END" },
          { key: "id", label: "ID" },
        ]);
      },
    }),
  ],
});
