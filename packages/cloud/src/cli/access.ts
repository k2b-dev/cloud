import type { AccessEntry, EntityListItem, PermissionLevel, Principal } from "../contracts";
import { arg, command, confirmFlag, flag, paginationFlags } from "./commands";
import type { CloudCliContext, CloudCliTableColumn } from "./index";

type GrantablePermission = Exclude<PermissionLevel, "none">;
type AccessPermission = GrantablePermission;

type PaginationResponse = {
  has_next?: boolean;
  hasNext?: boolean;
};

type EntitiesResponse = {
  items: EntityListItem[];
  pagination?: PaginationResponse;
};

export type AccessResource = {
  id: string;
  label: string;
};

export type AccessCommandResourceResolver<TResource extends AccessResource> = (ctx: CloudCliContext, args: string[]) => Promise<TResource>;

export type AccessCommandAdapter<TResource extends AccessResource> = {
  resourceLabel: string;
  resourceArgLabel?: string;
  resourceArgDescription?: string;
  resolveResource: AccessCommandResourceResolver<TResource>;
  list: (ctx: CloudCliContext, resource: TResource) => Promise<AccessEntry[]>;
  grant: (ctx: CloudCliContext, resource: TResource, principal: Principal, permission: AccessPermission) => Promise<AccessEntry>;
  update: (ctx: CloudCliContext, resource: TResource, accessId: string, permission: AccessPermission) => Promise<void>;
  revoke: (ctx: CloudCliContext, resource: TResource, accessId: string) => Promise<void>;
  allowedPermissions?: readonly AccessPermission[];
  allowPublic?: boolean;
  allowAuthenticated?: boolean;
  allowServiceAccounts?: boolean;
  examples?: {
    list?: readonly string[];
    grant?: readonly string[];
    set?: readonly string[];
    revoke?: readonly string[];
    searchPrincipals?: readonly string[];
  };
};

type PrincipalFlags = {
  user?: string;
  group?: string;
  serviceAccount?: string;
  authenticated?: boolean;
  public?: boolean;
};

const DEFAULT_ALLOWED_PERMISSIONS = ["read", "write", "admin"] as const satisfies readonly GrantablePermission[];
const PRINCIPAL_KINDS = ["user", "group", "service_account"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

const isUuid = (value: string): boolean => UUID_RE.test(value);

const queryString = (values: Record<string, string | number | boolean | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
};

const normalizeAllowedPermissions = (allowed: readonly AccessPermission[] | undefined): readonly AccessPermission[] =>
  allowed && allowed.length > 0 ? allowed : DEFAULT_ALLOWED_PERMISSIONS;

const permissionRank = (permission: PermissionLevel): number => {
  switch (permission) {
    case "none":
      return 0;
    case "read":
      return 1;
    case "write":
      return 2;
    case "admin":
      return 3;
  }
};

const assertAllowedPermission = (permission: AccessPermission, allowed: readonly AccessPermission[]) => {
  if (!allowed.includes(permission)) throw new Error(`Permission must be one of: ${allowed.join(", ")}.`);
};

const principalFlagCount = (flags: PrincipalFlags): number =>
  [flags.user, flags.group, flags.serviceAccount, flags.authenticated, flags.public].filter(Boolean).length;

const principalKey = (principal: Principal): string => {
  switch (principal.type) {
    case "user":
      return `user:${principal.userId}`;
    case "group":
      return `group:${principal.groupId}`;
    case "service_account":
      return `service_account:${principal.serviceAccountId}`;
    case "authenticated":
      return "authenticated";
    case "public":
      return "public";
  }
};

const entryDisplayName = (entry: AccessEntry): string => {
  if (entry.displayName) return entry.displayName;
  switch (entry.principal.type) {
    case "user":
      return entry.principal.userId;
    case "group":
      return entry.principal.groupId;
    case "service_account":
      return entry.principal.serviceAccountId;
    case "authenticated":
      return "All users (incl. guests)";
    case "public":
      return "Public";
  }
};

const formatEntityCandidate = (item: EntityListItem): string => {
  if (item.kind === "user") return `${item.user.displayName} (${item.user.uid}${item.user.mail ? `, ${item.user.mail}` : ""})`;
  if (item.kind === "group") return `${item.group.name} (${item.group.id})`;
  return `${item.serviceAccount.name} (${item.serviceAccount.id})`;
};

const exactEntityMatches = (items: EntityListItem[], kind: (typeof PRINCIPAL_KINDS)[number], ref: string): EntityListItem[] =>
  items.filter((item) => {
    if (item.kind !== kind) return false;
    if (kind === "user" && item.kind === "user") {
      return item.user.id === ref || item.user.uid === ref || item.user.mail === ref || item.user.displayName === ref;
    }
    if (kind === "group" && item.kind === "group") return item.group.id === ref || item.group.name === ref;
    if (kind === "service_account" && item.kind === "service_account") {
      return item.serviceAccount.id === ref || item.serviceAccount.name === ref;
    }
    return false;
  });

export const listAccessPrincipalEntities = async (
  ctx: CloudCliContext,
  options: {
    search?: string;
    kinds?: readonly (typeof PRINCIPAL_KINDS)[number][];
    page?: number;
    perPage?: number;
  },
): Promise<EntitiesResponse> =>
  ctx.readJson<EntitiesResponse>(
    await ctx.fetch(
      `/api/accounts/entities${queryString({
        page: options.page ?? 1,
        per_page: options.perPage ?? 20,
        search: options.search,
        kinds: (options.kinds ?? PRINCIPAL_KINDS).join(","),
      })}`,
    ),
  );

const resolveEntityPrincipal = async (ctx: CloudCliContext, kind: PrincipalKind, ref: string): Promise<Principal> => {
  if (isUuid(ref)) {
    if (kind === "user") return { type: "user", userId: ref };
    if (kind === "group") return { type: "group", groupId: ref };
    return { type: "service_account", serviceAccountId: ref };
  }

  const exact: EntityListItem[] = [];
  const seen: EntityListItem[] = [];
  let page = 1;

  for (;;) {
    const payload = await listAccessPrincipalEntities(ctx, {
      search: ref,
      kinds: [kind],
      page,
      perPage: 100,
    });
    const items = payload.items.filter((item) => item.kind === kind);
    seen.push(...items);
    exact.push(...exactEntityMatches(items, kind, ref));
    if (!(payload.pagination?.has_next ?? payload.pagination?.hasNext)) break;
    page += 1;
  }

  if (exact.length === 1) {
    const item = exact[0]!;
    if (item.kind === "user") return { type: "user", userId: item.user.id };
    if (item.kind === "group") return { type: "group", groupId: item.group.id };
    return { type: "service_account", serviceAccountId: item.serviceAccount.id };
  }

  if (exact.length > 1)
    throw new Error(`${kind.replace("_", " ")} "${ref}" is ambiguous. Use one of: ${exact.map(formatEntityCandidate).join(", ")}`);

  const candidates = seen.slice(0, 5).map(formatEntityCandidate).join(", ");
  throw new Error(
    candidates
      ? `${kind.replace("_", " ")} "${ref}" was not found by exact id/name. Similar matches: ${candidates}`
      : `${kind.replace("_", " ")} "${ref}" was not found.`,
  );
};

export const resolveAccessPrincipal = async (
  ctx: CloudCliContext,
  flags: PrincipalFlags,
  options: { allowPublic?: boolean; allowAuthenticated?: boolean; allowServiceAccounts?: boolean } = {},
): Promise<Principal> => {
  const count = principalFlagCount(flags);
  if (count !== 1) {
    const allowedFlags = [
      "--user",
      "--group",
      ...(options.allowAuthenticated === false ? [] : ["--authenticated"]),
      ...(options.allowPublic === true ? ["--public"] : []),
      ...(options.allowServiceAccounts === true ? ["--service-account"] : []),
    ];
    throw new Error(`Pass exactly one principal flag: ${allowedFlags.join(", ")}.`);
  }
  if (flags.public && options.allowPublic !== true) throw new Error("This resource does not allow public access grants.");
  if (flags.authenticated && options.allowAuthenticated === false) {
    throw new Error("This resource does not allow authenticated-audience grants.");
  }
  if (flags.serviceAccount && options.allowServiceAccounts !== true) {
    throw new Error("Service-account grants are hidden by default. Enable allowServiceAccounts for this access command.");
  }
  if (flags.authenticated) return { type: "authenticated" };
  if (flags.public) return { type: "public" };
  if (flags.user) return resolveEntityPrincipal(ctx, "user", flags.user);
  if (flags.group) return resolveEntityPrincipal(ctx, "group", flags.group);
  return resolveEntityPrincipal(ctx, "service_account", flags.serviceAccount!);
};

const entryTypeLabel = (entry: AccessEntry): string => {
  if (entry.principal.type !== "service_account") return entry.principal.type;
  return entry.serviceAccountKind === "agent" ? "agent" : "service account";
};

// Resource-bound service accounts back resource API keys, which are managed with those keys.
const accessRows = (entries: AccessEntry[], options: { includeServiceAccounts?: boolean } = {}) =>
  entries
    .filter((entry) => options.includeServiceAccounts || entry.serviceAccountKind !== "resource_bound")
    .sort((a, b) => {
      const rank = permissionRank(b.permission) - permissionRank(a.permission);
      if (rank !== 0) return rank;
      return entryDisplayName(a).localeCompare(entryDisplayName(b));
    })
    .map((entry) => ({
      accessId: entry.id,
      principal: entryDisplayName(entry),
      type: entryTypeLabel(entry),
      permission: entry.permission,
      createdAt: entry.createdAt,
    }));

const printStructured = (ctx: CloudCliContext, value: unknown): boolean => {
  if (ctx.options.output === "json") ctx.json(value);
  else if (ctx.options.output === "jsonl") ctx.jsonLine(value);
  else return false;
  return true;
};

export const printAccessEntries = (
  ctx: CloudCliContext,
  entries: AccessEntry[],
  options: { includeServiceAccounts?: boolean; jsonValue?: unknown } = {},
) => {
  if (printStructured(ctx, options.jsonValue ?? entries)) return;
  const rows = accessRows(entries, options);
  if (rows.length === 0) {
    ctx.print("No direct grants.");
    return;
  }
  ctx.table(rows, [
    { key: "principal", label: "PRINCIPAL" },
    { key: "type", label: "TYPE" },
    { key: "permission", label: "PERMISSION" },
    { key: "accessId", label: "ACCESS ID" },
  ]);
};

const printPrincipalEntities = (ctx: CloudCliContext, payload: EntitiesResponse) => {
  if (printStructured(ctx, payload)) return;
  const rows = payload.items.map((item) => {
    if (item.kind === "user") {
      return {
        kind: "user",
        id: item.user.id,
        name: item.user.displayName,
        handle: item.user.uid,
        detail: item.user.mail ?? "",
      };
    }
    if (item.kind === "group") {
      return {
        kind: "group",
        id: item.group.id,
        name: item.group.name,
        handle: item.group.provider,
        detail: item.group.description ?? "",
      };
    }
    return {
      kind: "service_account",
      id: item.serviceAccount.id,
      name: item.serviceAccount.name,
      handle: item.serviceAccount.kind,
      detail: item.serviceAccount.appId ?? "",
    };
  });
  ctx.table(rows, [
    { key: "kind", label: "KIND" },
    { key: "name", label: "NAME" },
    { key: "handle", label: "HANDLE" },
    { key: "id", label: "ID" },
  ] as CloudCliTableColumn<(typeof rows)[number]>[]);
};

const principalFlags = (options: {
  includePublicFlag: boolean;
  includeAuthenticatedFlag: boolean;
  includeServiceAccountFlag: boolean;
}) => ({
  user: flag.string({ description: "User id, uid, email, or exact display name" }),
  group: flag.string({ description: "Group id or exact name" }),
  ...(options.includeServiceAccountFlag
    ? { serviceAccount: flag.string({ name: "service-account", description: "Service account id or exact name" }) }
    : {}),
  ...(options.includeAuthenticatedFlag ? { authenticated: flag.boolean({ description: "Signed-in users, including guests" }) } : {}),
  ...(options.includePublicFlag ? { public: flag.boolean({ description: "Anyone with the link, including anonymous users" }) } : {}),
});

const accessIdFlag = {
  accessId: flag.string({ name: "access-id", description: "Access entry id from `access list`" }),
};

export const createAccessCommands = <TResource extends AccessResource>(adapter: AccessCommandAdapter<TResource>) => {
  const allowed = normalizeAllowedPermissions(adapter.allowedPermissions);
  const searchableKinds = adapter.allowServiceAccounts ? PRINCIPAL_KINDS : (["user", "group"] as const);
  const principalFlagOptions = {
    includePublicFlag: adapter.allowPublic === true,
    includeAuthenticatedFlag: adapter.allowAuthenticated !== false,
    includeServiceAccountFlag: adapter.allowServiceAccounts === true,
  };
  const resolve = (ctx: CloudCliContext, args: string[]) => adapter.resolveResource(ctx, args);
  const resourceArgs = {
    args: arg.rest({
      valueLabel: adapter.resourceArgLabel ?? adapter.resourceLabel,
      description: adapter.resourceArgDescription ?? `Optional ${adapter.resourceLabel} reference consumed by the app.`,
    }),
  };

  const list = command("access list", {
    summary: `List direct ${adapter.resourceLabel} grants`,
    description:
      "Shows the same direct access entries as the Cloud PermissionEditor. Inherited/effective access is intentionally not expanded here.",
    args: resourceArgs,
    flags: {
      includeServiceAccounts: flag.boolean({
        name: "include-service-accounts",
        description: "Also show grants of resource-bound service accounts (resource API keys).",
      }),
    },
    examples: adapter.examples?.list,
    async run({ ctx, args, flags }) {
      const resource = await resolve(ctx, args.args);
      const entries = await adapter.list(ctx, resource);
      printAccessEntries(ctx, entries, {
        includeServiceAccounts: flags.includeServiceAccounts,
        jsonValue: { resource, entries },
      });
    },
  });

  const grant = command("access grant", {
    summary: `Grant direct ${adapter.resourceLabel} access`,
    description: "Creates a new direct grant. If the principal already has a direct grant, use `access set` to update it idempotently.",
    args: resourceArgs,
    flags: {
      ...principalFlags(principalFlagOptions),
      permission: flag.enum(allowed, { required: true, description: `Permission to grant. Allowed: ${allowed.join(", ")}` }),
    },
    examples: adapter.examples?.grant,
    async run({ ctx, args, flags }) {
      const resource = await resolve(ctx, args.args);
      const permission = flags.permission as AccessPermission;
      assertAllowedPermission(permission, allowed);
      const principal = await resolveAccessPrincipal(ctx, flags as PrincipalFlags, adapter);
      const entry = await adapter.grant(ctx, resource, principal, permission);
      if (!printStructured(ctx, { resource, entry }))
        ctx.print(`Granted ${permission} on ${resource.label} to ${entryDisplayName(entry)}.`);
    },
  });

  const set = command("access set", {
    summary: `Create or update direct ${adapter.resourceLabel} access`,
    description:
      "Idempotent agent-friendly command: with --access-id it patches that entry; otherwise it resolves the principal, updates an existing direct grant, or creates one.",
    args: resourceArgs,
    flags: {
      ...principalFlags(principalFlagOptions),
      ...accessIdFlag,
      permission: flag.enum(allowed, { required: true, description: `Permission to set. Allowed: ${allowed.join(", ")}` }),
    },
    examples: adapter.examples?.set,
    async run({ ctx, args, flags }) {
      const resource = await resolve(ctx, args.args);
      const permission = flags.permission as AccessPermission;
      assertAllowedPermission(permission, allowed);

      if (flags.accessId) {
        await adapter.update(ctx, resource, flags.accessId, permission);
        if (!printStructured(ctx, { resource, accessId: flags.accessId, permission, action: "updated" })) {
          ctx.print(`Updated ${flags.accessId} to ${permission} on ${resource.label}.`);
        }
        return;
      }

      const principal = await resolveAccessPrincipal(ctx, flags as PrincipalFlags, adapter);
      const entries = await adapter.list(ctx, resource);
      const existing = entries.find((entry) => principalKey(entry.principal) === principalKey(principal));
      if (existing) {
        await adapter.update(ctx, resource, existing.id, permission);
        if (!printStructured(ctx, { resource, accessId: existing.id, permission, action: "updated" })) {
          ctx.print(`Updated ${entryDisplayName(existing)} to ${permission} on ${resource.label}.`);
        }
        return;
      }
      const entry = await adapter.grant(ctx, resource, principal, permission);
      if (!printStructured(ctx, { resource, entry, action: "created" })) {
        ctx.print(`Granted ${permission} on ${resource.label} to ${entryDisplayName(entry)}.`);
      }
    },
  });

  const revoke = command("access revoke", {
    summary: `Revoke direct ${adapter.resourceLabel} access`,
    description:
      "Deletes one direct grant. Pass --access-id from `access list`, or pass exactly one principal flag to resolve the matching direct grant.",
    args: resourceArgs,
    flags: {
      ...principalFlags(principalFlagOptions),
      ...accessIdFlag,
      yes: confirmFlag("Confirm access revocation"),
    },
    examples: adapter.examples?.revoke,
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Refusing to revoke access without --yes.");
      const resource = await resolve(ctx, args.args);
      let accessId = flags.accessId;
      let label = accessId;

      if (!accessId) {
        const principal = await resolveAccessPrincipal(ctx, flags as PrincipalFlags, adapter);
        const entries = await adapter.list(ctx, resource);
        const entry = entries.find((candidate) => principalKey(candidate.principal) === principalKey(principal));
        if (!entry) throw new Error("No direct grant for that principal.");
        accessId = entry.id;
        label = entryDisplayName(entry);
      } else if (principalFlagCount(flags as PrincipalFlags) > 0) {
        throw new Error("Pass either --access-id or one principal flag, not both.");
      }

      await adapter.revoke(ctx, resource, accessId);
      if (!printStructured(ctx, { resource, accessId, action: "revoked" })) {
        ctx.print(`Revoked access for ${label} on ${resource.label}.`);
      }
    },
  });

  const searchPrincipals = command("access search-principals", {
    summary: "Search principals for access grants",
    description: "Uses the same `/api/accounts/entities` principal search endpoint as the Cloud PermissionEditor.",
    args: {
      query: arg.required({ description: "Search text; exact names are safest for grant/set commands." }),
    },
    flags: {
      kind: flag.stringList({
        separator: ",",
        default: searchableKinds,
        description: `Comma-separated principal kinds. Allowed: ${searchableKinds.join(", ")}`,
      }),
      ...paginationFlags({ defaultPerPage: 20, maxPerPage: 100 }),
    },
    examples: adapter.examples?.searchPrincipals ?? [`cld <app> access search-principals val --kind user,group`],
    async run({ ctx, args, flags }) {
      const kinds = flags.kind.filter((kind): kind is (typeof PRINCIPAL_KINDS)[number] =>
        (searchableKinds as readonly string[]).includes(kind),
      );
      if (kinds.length !== flags.kind.length) throw new Error(`--kind must contain only: ${searchableKinds.join(", ")}.`);
      const payload = await listAccessPrincipalEntities(ctx, {
        search: args.query,
        kinds,
        page: flags.page,
        perPage: flags.perPage,
      });
      printPrincipalEntities(ctx, payload);
    },
  });

  return [list, grant, set, revoke, searchPrincipals];
};
