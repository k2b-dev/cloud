import {
  arg,
  type CliInputFlagValue,
  type CloudCliContext,
  command,
  confirmFlag,
  createAccessCommands,
  defineCliCommands,
  flag,
  printRows as printJsonOrTable,
  printStructured,
  readCliInput,
} from "@k2b/cloud/cli";
import type { AccessEntry, PermissionLevel, Principal } from "@k2b/cloud/contracts";
import type {
  OpeningRule,
  PublicSection,
  PublicSectionInput,
  PublicStatus,
  UpcomingSlot,
  Venue,
  VenueDashboard,
  VenueInput,
} from "./contracts";

type VenueApiKey = {
  id: string;
  name: string;
  tokenPrefix: string;
  permission: "none" | "read" | "write" | "admin";
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

type VenueApiKeyCreateResponse = {
  credential: VenueApiKey;
  token: string;
};

const VENUE_DEFAULT_KEY = "venue.venue";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_PATTERN = /^[0-9A-Za-z]{6}$/;

const apiPath = (path = "") => `/api/venue${path}`;

const apiGet = async <T>(ctx: CloudCliContext, path: string): Promise<T> => ctx.readJson<T>(await ctx.fetch(apiPath(path)));

const apiJson = async <T>(ctx: CloudCliContext, method: string, path: string, body?: unknown): Promise<T> =>
  ctx.readJson<T>(
    await ctx.fetch(apiPath(path), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "venue";

const encode = (value: string) => encodeURIComponent(value);

const listVenues = async (ctx: CloudCliContext): Promise<Venue[]> => {
  const response = await apiGet<{ venues: Venue[] }>(ctx, "/venues");
  return response.venues;
};

const resolveVenueRef = async (ctx: CloudCliContext, ref?: string): Promise<Venue> => {
  const venueRef = ref ?? (await ctx.getDefault(VENUE_DEFAULT_KEY));
  if (!venueRef) throw new Error("Missing venue. Pass <venue> or run `cld venue use <venue>`.");

  if (UUID_PATTERN.test(venueRef)) throw new Error("Legacy Venue UUIDs are not accepted. Use the 6-character Venue ID.");

  const venues = await listVenues(ctx);
  const matches = venues.filter((venue) => venue.slug === venueRef || venue.name === venueRef);
  if (SHORT_ID_PATTERN.test(venueRef)) {
    const response = await ctx.fetch(apiPath(`/venues/${encode(venueRef)}/dashboard`));
    if (response.ok) matches.push((await ctx.readJson<VenueDashboard>(response)).venue);
    else if (response.status !== 404) await ctx.readJson(response);
  }
  const unique = [...new Map(matches.map((venue) => [venue.id, venue])).values()];
  if (unique.length === 1) return unique[0]!;
  if (unique.length > 1) throw new Error(`Venue "${venueRef}" is ambiguous. Use one of: ${unique.map((item) => item.id).join(", ")}`);
  throw new Error(`Venue "${venueRef}" was not found by id, slug, or exact name.`);
};

const loadDashboard = async (ctx: CloudCliContext, ref?: string): Promise<VenueDashboard> => {
  const venue = await resolveVenueRef(ctx, ref);
  return apiGet<VenueDashboard>(ctx, `/venues/${encode(venue.id)}/dashboard`);
};

const venueRows = (venues: Venue[]) =>
  venues.map((venue) => ({
    name: venue.name,
    slug: venue.slug,
    permission: venue.permission ?? "",
    public: venue.publicEnabled ? "yes" : "no",
    mode: `${venue.openMode}/${venue.signupMode}`,
    id: venue.id,
  }));

const apiKeyRows = (keys: VenueApiKey[]) =>
  keys.map((key) => ({
    id: key.id,
    name: key.name,
    prefix: key.tokenPrefix,
    permission: key.permission,
    expiresAt: key.expiresAt ?? "",
    lastUsedAt: key.lastUsedAt ?? "",
  }));

const venueAccessCommands = createAccessCommands({
  resourceLabel: "venue",
  resourceArgLabel: "venue",
  resourceArgDescription: "Optional venue id, slug, or exact name. If omitted, the default from `cld venue use` is used.",
  resolveResource: async (ctx, args) => {
    if (args.length > 1) throw new Error(`Unexpected venue access arguments: ${args.slice(1).join(" ")}`);
    const venue = await resolveVenueRef(ctx, args[0]);
    return {
      id: venue.id,
      label: `${venue.name} (${venue.slug})`,
    };
  },
  list: async (ctx, venue) => (await apiGet<{ entries: AccessEntry[] }>(ctx, `/venues/${encode(venue.id)}/access`)).entries,
  grant: async (ctx, venue, principal: Principal, permission: PermissionLevel) =>
    apiJson<AccessEntry>(ctx, "POST", `/venues/${encode(venue.id)}/access`, { principal, permission }),
  update: async (ctx, venue, accessId, permission) => {
    await apiJson<unknown>(ctx, "PATCH", `/venues/${encode(venue.id)}/access/${encode(accessId)}`, { permission });
  },
  revoke: async (ctx, venue, accessId) => {
    await apiJson<unknown>(ctx, "DELETE", `/venues/${encode(venue.id)}/access/${encode(accessId)}`);
  },
  examples: {
    list: ['cld venue access list "Cafe Counter"', "cld venue access list --include-service-accounts"],
    grant: [
      'cld venue access grant "Cafe Counter" --user valentin.kolb --permission read',
      'cld venue access grant "Cafe Counter" --group "Staff" --permission write',
      'cld venue access grant "Cafe Counter" --authenticated --permission read',
    ],
    set: [
      'cld venue access set "Cafe Counter" --user valentin.kolb --permission admin',
      "cld venue access set --access-id 00000000-0000-4000-8000-000000000000 --permission write",
    ],
    revoke: [
      'cld venue access revoke "Cafe Counter" --user valentin.kolb --yes',
      "cld venue access revoke --access-id 00000000-0000-4000-8000-000000000000 --yes",
    ],
    searchPrincipals: [
      "cld venue access search-principals val --kind user,group",
      'cld venue access search-principals "Staff" --kind group',
    ],
  },
});

const openingRuleRows = (rules: OpeningRule[]) =>
  rules.map((rule) => ({
    id: rule.id,
    weekday: rule.weekday,
    start: rule.startTime,
    end: rule.endTime,
    note: rule.note ?? "",
  }));

const sectionRows = (sections: PublicSection[]) =>
  sections.map((section) => ({
    id: section.id,
    kind: section.kind,
    title: section.title,
    enabled: section.enabled ? "yes" : "no",
    position: section.position,
  }));

const slotRows = (slots: UpcomingSlot[]) =>
  slots.map((slot) => ({
    templateId: slot.template.id,
    date: slot.date,
    title: slot.template.title,
    time: `${slot.template.startTime}-${slot.template.endTime}`,
    assigned: slot.assignedCount,
    missing: slot.missingPeople,
    full: slot.full ? "yes" : "no",
  }));

const readJsonInput = async <T>(input: CliInputFlagValue, label: string): Promise<T> => {
  const text = await readCliInput(input, { label, required: true, trimFinalNewline: true });
  return JSON.parse(text ?? "{}") as T;
};

const buildVenueInput = (
  base: Venue | undefined,
  flags: {
    name?: string;
    slug?: string;
    icon?: string;
    description?: string;
    clearDescription: boolean;
    timezone?: string;
    openMode?: "regular" | "staffed" | "combined";
    signupMode?: "templates" | "free" | "both";
    public: boolean;
    private: boolean;
    feedback: boolean;
    noFeedback: boolean;
    accentColor?: string;
  },
): VenueInput => {
  if (flags.public && flags.private) throw new Error("Pass only one of --public or --private.");
  if (flags.feedback && flags.noFeedback) throw new Error("Pass only one of --feedback or --no-feedback.");

  const name = flags.name ?? base?.name;
  if (!name) throw new Error("Missing venue name. Pass --name <name>.");

  return {
    name,
    slug: flags.slug ?? base?.slug ?? slugify(name),
    icon: flags.icon ?? base?.icon ?? "ti ti-building-carousel",
    description: flags.clearDescription ? null : (flags.description ?? base?.description ?? null),
    timezone: flags.timezone ?? base?.timezone ?? "Europe/Berlin",
    openMode: flags.openMode ?? base?.openMode ?? "combined",
    signupMode: flags.signupMode ?? base?.signupMode ?? "both",
    publicEnabled: flags.private ? false : flags.public ? true : (base?.publicEnabled ?? true),
    feedbackEnabled: flags.noFeedback ? false : flags.feedback ? true : (base?.feedbackEnabled ?? true),
    accentColor: flags.accentColor ?? base?.accentColor ?? "#2563eb",
    logoBase64: base?.logoBase64 ?? null,
    bannerBase64: base?.bannerBase64 ?? null,
  };
};

const printMutationResult = (ctx: CloudCliContext, result: unknown, fallback: string) => {
  if (ctx.options.output === "json") {
    ctx.json(result);
    return;
  }
  const message =
    result && typeof result === "object" && "message" in result && typeof (result as { message?: unknown }).message === "string"
      ? (result as { message: string }).message
      : fallback;
  ctx.print(message);
};

export default defineCliCommands({
  name: "venue",
  summary: "Manage venues.",
  groupSummaries: {
    access: "Manage direct access to venues",
    "api-keys": "Create, inspect, and revoke venue API keys",
    "opening-rules": "Manage recurring venue opening rules",
    sections: "Manage public venue sections",
    shifts: "Inspect and cancel venue shift assignments",
  },
  commands: [
    command("list", {
      summary: "List accessible venues",
      async run({ ctx }) {
        const venues = await listVenues(ctx);
        printJsonOrTable(ctx, { venues }, venueRows(venues), [
          { key: "name" },
          { key: "slug" },
          { key: "permission" },
          { key: "public" },
          { key: "mode" },
          { key: "id" },
        ]);
      },
    }),
    command("use", {
      summary: "Set the default venue",
      args: { venue: arg.required({ valueLabel: "venue" }) },
      async run({ ctx, args }) {
        const venue = await resolveVenueRef(ctx, args.venue);
        await ctx.setDefault(VENUE_DEFAULT_KEY, venue.id);
        ctx.print(`Default venue: ${venue.name}`);
      },
    }),
    command("get", {
      summary: "Show a venue dashboard payload",
      args: { venue: arg.optional({ valueLabel: "venue" }) },
      async run({ ctx, args }) {
        const dashboard = await loadDashboard(ctx, args.venue);
        if (!printStructured(ctx, dashboard)) ctx.print(JSON.stringify(dashboard, null, 2));
      },
    }),
    command("status", {
      summary: "Show public venue status",
      args: { venue: arg.optional({ valueLabel: "venue-or-slug" }) },
      async run({ ctx, args }) {
        const venue = await resolveVenueRef(ctx, args.venue);
        const status = await apiGet<PublicStatus>(ctx, `/public/${encode(venue.id)}/status`);
        if (!printStructured(ctx, status)) {
          ctx.table(
            [
              {
                venue: status.venue.name,
                status: status.statusLabel,
                today: status.todayLabel,
                next: status.nextOpeningLabel ?? "",
              },
            ],
            [{ key: "venue" }, { key: "status" }, { key: "today" }, { key: "next" }],
          );
        }
      },
    }),
    command("create", {
      summary: "Create a venue",
      flags: {
        name: flag.string({ required: true }),
        slug: flag.string(),
        icon: flag.string(),
        description: flag.string(),
        clearDescription: flag.boolean({ name: "clear-description" }),
        timezone: flag.string(),
        openMode: flag.enum(["regular", "staffed", "combined"] as const, { name: "open-mode" }),
        signupMode: flag.enum(["templates", "free", "both"] as const, { name: "signup-mode" }),
        public: flag.boolean(),
        private: flag.boolean(),
        feedback: flag.boolean(),
        noFeedback: flag.boolean({ name: "no-feedback" }),
        accentColor: flag.string({ name: "accent-color" }),
      },
      async run({ ctx, flags }) {
        const venue = await apiJson<Venue>(ctx, "POST", "/venues", buildVenueInput(undefined, flags));
        if (!printStructured(ctx, venue)) ctx.print(`Created ${venue.name} (${venue.id})`);
      },
    }),
    command("update", {
      summary: "Update a venue",
      args: { venue: arg.required({ valueLabel: "venue" }) },
      flags: {
        name: flag.string(),
        slug: flag.string(),
        icon: flag.string(),
        description: flag.string(),
        clearDescription: flag.boolean({ name: "clear-description" }),
        timezone: flag.string(),
        openMode: flag.enum(["regular", "staffed", "combined"] as const, { name: "open-mode" }),
        signupMode: flag.enum(["templates", "free", "both"] as const, { name: "signup-mode" }),
        public: flag.boolean(),
        private: flag.boolean(),
        feedback: flag.boolean(),
        noFeedback: flag.boolean({ name: "no-feedback" }),
        accentColor: flag.string({ name: "accent-color" }),
      },
      async run({ ctx, args, flags }) {
        const venue = await resolveVenueRef(ctx, args.venue);
        const result = await apiJson<Venue>(ctx, "PATCH", `/venues/${encode(venue.id)}`, buildVenueInput(venue, flags));
        printMutationResult(ctx, result, `Updated ${result.name}`);
      },
    }),
    command("delete", {
      summary: "Delete a venue and all venue-owned data",
      args: { venue: arg.required({ valueLabel: "venue" }) },
      flags: { yes: confirmFlag("Delete the venue") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete without --yes.");
        const venue = await resolveVenueRef(ctx, args.venue);
        const result = await apiJson<unknown>(ctx, "DELETE", `/venues/${encode(venue.id)}`);
        printMutationResult(ctx, result, `Deleted ${venue.name}`);
      },
    }),
    ...venueAccessCommands,
    command("api-keys list", {
      summary: "List venue API keys",
      args: { venue: arg.optional({ valueLabel: "venue" }) },
      async run({ ctx, args }) {
        const venue = await resolveVenueRef(ctx, args.venue);
        const response = await apiGet<{ items: VenueApiKey[] }>(ctx, `/venues/${encode(venue.id)}/api-keys`);
        printJsonOrTable(ctx, response, apiKeyRows(response.items), [
          { key: "name" },
          { key: "prefix" },
          { key: "permission" },
          { key: "expiresAt" },
          { key: "lastUsedAt" },
          { key: "id" },
        ]);
      },
    }),
    command("api-keys create", {
      summary: "Create a venue API key",
      args: { venue: arg.optional({ valueLabel: "venue" }) },
      flags: {
        name: flag.string({ required: true }),
        permission: flag.enum(["read", "write", "admin"] as const, { default: "read" }),
        expiresAt: flag.string({ name: "expires-at", description: "ISO datetime or omit for no expiry" }),
      },
      async run({ ctx, args, flags }) {
        const venue = await resolveVenueRef(ctx, args.venue);
        const response = await apiJson<VenueApiKeyCreateResponse>(ctx, "POST", `/venues/${encode(venue.id)}/api-keys`, {
          name: flags.name,
          permission: flags.permission,
          expiresAt: flags.expiresAt ?? null,
        });
        if (!printStructured(ctx, response)) {
          ctx.print(`Created ${response.credential.name}`);
          ctx.print("Store this token now. It cannot be shown again.");
          ctx.print(`Prefix: ${response.credential.tokenPrefix}`);
          ctx.print(`Token: ${response.token}`);
        }
      },
    }),
    command("api-keys revoke", {
      summary: "Revoke a venue API key",
      args: {
        venue: arg.required({ valueLabel: "venue" }),
        credential: arg.required({ valueLabel: "credential-id" }),
      },
      flags: { yes: confirmFlag("Revoke the API key") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to revoke without --yes.");
        const venue = await resolveVenueRef(ctx, args.venue);
        const result = await apiJson<unknown>(ctx, "DELETE", `/venues/${encode(venue.id)}/api-keys/${encode(args.credential)}`);
        printMutationResult(ctx, result, "API key revoked");
      },
    }),
    command("opening-rules list", {
      summary: "List opening rules",
      args: { venue: arg.optional({ valueLabel: "venue" }) },
      async run({ ctx, args }) {
        const dashboard = await loadDashboard(ctx, args.venue);
        printJsonOrTable(ctx, { items: dashboard.openingRules }, openingRuleRows(dashboard.openingRules), [
          { key: "weekday" },
          { key: "start" },
          { key: "end" },
          { key: "note" },
          { key: "id" },
        ]);
      },
    }),
    command("opening-rules create", {
      summary: "Create an opening rule",
      args: { venue: arg.optional({ valueLabel: "venue" }) },
      flags: {
        weekday: flag.int({ required: true, min: 0, max: 6 }),
        start: flag.string({ required: true, description: "HH:MM" }),
        end: flag.string({ required: true, description: "HH:MM" }),
        note: flag.string(),
      },
      async run({ ctx, args, flags }) {
        const venue = await resolveVenueRef(ctx, args.venue);
        const result = await apiJson<OpeningRule>(ctx, "POST", `/venues/${encode(venue.id)}/opening-rules`, {
          weekday: flags.weekday,
          startTime: flags.start,
          endTime: flags.end,
          note: flags.note ?? null,
        });
        if (!printStructured(ctx, result)) ctx.print(`Created opening rule ${result.id}`);
      },
    }),
    command("opening-rules delete", {
      summary: "Delete an opening rule",
      args: {
        venue: arg.required({ valueLabel: "venue" }),
        rule: arg.required({ valueLabel: "rule-id" }),
      },
      flags: { yes: confirmFlag("Delete the opening rule") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete without --yes.");
        const venue = await resolveVenueRef(ctx, args.venue);
        const result = await apiJson<unknown>(ctx, "DELETE", `/venues/${encode(venue.id)}/opening-rules/${encode(args.rule)}`);
        printMutationResult(ctx, result, "Opening rule deleted");
      },
    }),
    command("sections list", {
      summary: "List public sections",
      args: { venue: arg.optional({ valueLabel: "venue" }) },
      async run({ ctx, args }) {
        const dashboard = await loadDashboard(ctx, args.venue);
        printJsonOrTable(ctx, { items: dashboard.sections }, sectionRows(dashboard.sections), [
          { key: "kind" },
          { key: "title" },
          { key: "enabled" },
          { key: "position" },
          { key: "id" },
        ]);
      },
    }),
    command("sections create", {
      summary: "Create a public section",
      args: { venue: arg.optional({ valueLabel: "venue" }) },
      flags: {
        kind: flag.enum(["markdown", "menu", "notice", "links"] as const, { required: true }),
        title: flag.string({ required: true }),
        content: flag.input({ valueLabel: "json", description: "Section content JSON" }),
        disabled: flag.boolean(),
        position: flag.int({ default: 0 }),
      },
      async run({ ctx, args, flags }) {
        if (!flags.kind) throw new Error("Missing required flag --kind.");
        if (!flags.title) throw new Error("Missing required flag --title.");
        const venue = await resolveVenueRef(ctx, args.venue);
        const input: PublicSectionInput = {
          kind: flags.kind,
          title: flags.title,
          content: flags.content.provided ? await readJsonInput<Record<string, unknown>>(flags.content, "section content") : {},
          enabled: !flags.disabled,
          position: flags.position ?? 0,
        };
        const section = await apiJson<PublicSection>(ctx, "POST", `/venues/${encode(venue.id)}/sections`, input);
        if (!printStructured(ctx, section)) ctx.print(`Created section ${section.id}`);
      },
    }),
    command("sections update", {
      summary: "Update a public section",
      args: {
        venue: arg.required({ valueLabel: "venue" }),
        section: arg.required({ valueLabel: "section-id" }),
      },
      flags: {
        kind: flag.enum(["markdown", "menu", "notice", "links"] as const, { required: true }),
        title: flag.string({ required: true }),
        content: flag.input({ valueLabel: "json", description: "Section content JSON", required: true }),
        disabled: flag.boolean(),
        position: flag.int({ default: 0 }),
      },
      async run({ ctx, args, flags }) {
        if (!flags.kind) throw new Error("Missing required flag --kind.");
        if (!flags.title) throw new Error("Missing required flag --title.");
        const venue = await resolveVenueRef(ctx, args.venue);
        const input: PublicSectionInput = {
          kind: flags.kind,
          title: flags.title,
          content: await readJsonInput<Record<string, unknown>>(flags.content, "section content"),
          enabled: !flags.disabled,
          position: flags.position ?? 0,
        };
        const result = await apiJson<PublicSection>(ctx, "PATCH", `/venues/${encode(venue.id)}/sections/${encode(args.section)}`, input);
        printMutationResult(ctx, result, `Updated section ${result.id}`);
      },
    }),
    command("sections delete", {
      summary: "Delete a public section",
      args: {
        venue: arg.required({ valueLabel: "venue" }),
        section: arg.required({ valueLabel: "section-id" }),
      },
      flags: { yes: confirmFlag("Delete the public section") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete without --yes.");
        const venue = await resolveVenueRef(ctx, args.venue);
        const result = await apiJson<unknown>(ctx, "DELETE", `/venues/${encode(venue.id)}/sections/${encode(args.section)}`);
        printMutationResult(ctx, result, "Section deleted");
      },
    }),
    command("shifts list", {
      summary: "List upcoming shift slots",
      args: { venue: arg.optional({ valueLabel: "venue" }) },
      async run({ ctx, args }) {
        const dashboard = await loadDashboard(ctx, args.venue);
        printJsonOrTable(ctx, { items: dashboard.slots }, slotRows(dashboard.slots), [
          { key: "date" },
          { key: "title" },
          { key: "time" },
          { key: "assigned" },
          { key: "missing" },
          { key: "full" },
          { key: "templateId" },
        ]);
      },
    }),
    command("shifts cancel", {
      summary: "Cancel a shift assignment",
      args: {
        venue: arg.required({ valueLabel: "venue" }),
        assignment: arg.required({ valueLabel: "assignment-id" }),
      },
      flags: { yes: confirmFlag("Cancel the assignment") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to cancel without --yes.");
        const venue = await resolveVenueRef(ctx, args.venue);
        const result = await apiJson<unknown>(ctx, "DELETE", `/venues/${encode(venue.id)}/assignments/${encode(args.assignment)}`);
        printMutationResult(ctx, result, "Assignment cancelled");
      },
    }),
  ],
});
