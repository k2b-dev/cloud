import {
  arg,
  type CloudCliContext,
  command,
  confirmFlag,
  flag,
  listAccessPrincipalEntities,
  paginationFlags,
} from "@k2b/cloud/cli";
import type { AccessEntry } from "@k2b/cloud/contracts";
import {
  ACCESS_RESOURCE_TYPES,
  type AccessPermission,
  accessPermissionsForResource,
  accessResourcePath,
  assertAccessPermission,
  assertAccessPrincipal,
  PERMISSION_LEVELS,
  principalKey,
  resolveAccessResource,
  resolvePrincipalForAccess,
} from "./access-support";
import { jsonRequest, type MessageResponse, printCliStructured, printJsonOrMessage, printReference, readApi } from "./runtime";

const principalLabel = (entry: AccessEntry): string => {
  if (entry.displayName) return entry.displayName;
  if (entry.principal.type === "user") return entry.principal.userId;
  if (entry.principal.type === "group") return entry.principal.groupId;
  if (entry.principal.type === "service_account") return entry.principal.serviceAccountId;
  return entry.principal.type === "authenticated" ? "All authenticated accounts" : "Public";
};

const printGridsAccessEntries = (
  ctx: CloudCliContext,
  resource: Awaited<ReturnType<typeof resolveAccessResource>>,
  entries: AccessEntry[],
  includeServiceAccounts: boolean,
) => {
  if (printCliStructured(ctx, { resource, entries })) return;
  const rows = entries
    .filter((entry) => includeServiceAccounts || entry.principal.type !== "service_account")
    .map((entry) => ({
      principal: principalLabel(entry),
      type: entry.principal.type,
      permission: entry.permission,
      accessId: entry.id,
    }));
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

export const accessCommands = [
  command("access reference", {
    summary: "Show Grids resource access levels",
    description: "Raw Grids access is granted on a base. Published Grids Apps have their own read access.",
    examples: ["cld grids access reference", "cld grids access reference --json"],
    async run({ ctx }) {
      const reference = {
        resourceTypes: ACCESS_RESOURCE_TYPES.map((type) => ({
          type,
          permissions: accessPermissionsForResource(type),
          principals:
            type === "base" ? ["user", "group", "service_account", "authenticated"] : ["user", "group", "authenticated", "public"],
        })),
        principalFlags: [
          "--user <id|uid|email|display name>",
          "--group <id|name>",
          "--service-account <id|name> (Base only)",
          "--authenticated",
          "--public (Grids App only)",
        ],
        examples: [
          "cld grids access list base Bookshop",
          "cld grids access set base Bookshop --group 'Bookshop staff' --permission write",
          "cld grids access grant app Bookshop Catalog --public --permission read",
          "cld grids access revoke app Bookshop Catalog --public --yes",
        ],
      };
      printReference(
        ctx,
        reference,
        [
          "Grids access",
          "",
          "Base access controls the complete raw Grids workspace. Grids App access controls one published app without granting raw base access.",
          "",
          "Resources:",
          ...reference.resourceTypes.map(
            (item) => `  ${item.type}: ${item.permissions.join(", ")}; principals: ${item.principals.join(", ")}`,
          ),
          "",
          "Principals:",
          ...reference.principalFlags.map((item) => `  ${item}`),
          "",
          "Examples:",
          ...reference.examples.map((item) => `  ${item}`),
        ].join("\n"),
      );
    },
  }),
  command("access list", {
    summary: "List direct grants for a Grids resource",
    args: {
      args: arg.rest({
        valueLabel: "resource-type refs",
        description: "Resource type followed by refs, e.g. base Bookshop or app Bookshop Catalog.",
      }),
    },
    flags: {
      includeServiceAccounts: flag.boolean({
        name: "include-service-accounts",
        description: "Include service-account grants in text output.",
      }),
    },
    async run({ ctx, args, flags }) {
      const resource = await resolveAccessResource(ctx, args.args);
      const entries = await readApi<AccessEntry[]>(ctx, accessResourcePath(resource));
      printGridsAccessEntries(ctx, resource, entries, flags.includeServiceAccounts);
    },
  }),
  command("access grant", {
    summary: "Create a direct Grids resource grant",
    args: {
      args: arg.rest({ valueLabel: "resource-type refs", description: "Resource type followed by resource refs." }),
    },
    flags: {
      user: flag.string({ description: "User id, uid, email, or exact display name" }),
      group: flag.string({ description: "Group id or exact name" }),
      serviceAccount: flag.string({ name: "service-account", description: "Service account id or exact name; Base grants only" }),
      authenticated: flag.boolean({ description: "Signed-in users" }),
      public: flag.boolean({ description: "Anyone with the link, including anonymous users" }),
      permission: flag.enum(PERMISSION_LEVELS, { required: true, description: "Permission to grant" }),
    },
    async run({ ctx, args, flags }) {
      const resource = await resolveAccessResource(ctx, args.args);
      const permission = flags.permission as AccessPermission;
      assertAccessPermission(resource, permission);
      const principal = await resolvePrincipalForAccess(ctx, flags);
      assertAccessPrincipal(resource, principal);
      const created = await readApi<{ accessId: string }>(
        ctx,
        accessResourcePath(resource),
        jsonRequest("POST", { principal, permission }),
      );
      printJsonOrMessage(
        ctx,
        {
          resource,
          principal,
          permission,
          ...created,
        },
        `Granted ${permission} on ${resource.label}.`,
      );
    },
  }),
  command("access set", {
    summary: "Create or update a direct Grids resource grant",
    description:
      "With --access-id this patches that grant. Otherwise the CLI resolves the principal and updates or creates its direct grant.",
    args: {
      args: arg.rest({ valueLabel: "resource-type refs", description: "Resource type followed by resource refs." }),
    },
    flags: {
      user: flag.string({ description: "User id, uid, email, or exact display name" }),
      group: flag.string({ description: "Group id or exact name" }),
      serviceAccount: flag.string({ name: "service-account", description: "Service account id or exact name; Base grants only" }),
      authenticated: flag.boolean({ description: "Signed-in users" }),
      public: flag.boolean({ description: "Anyone with the link, including anonymous users" }),
      accessId: flag.string({ name: "access-id", description: "Direct access entry id from access list" }),
      permission: flag.enum(PERMISSION_LEVELS, { required: true, description: "Permission to set" }),
    },
    async run({ ctx, args, flags }) {
      const resource = await resolveAccessResource(ctx, args.args);
      const permission = flags.permission as AccessPermission;
      assertAccessPermission(resource, permission);
      if (flags.accessId) {
        await readApi<MessageResponse>(ctx, `/access/${encodeURIComponent(flags.accessId)}`, jsonRequest("PATCH", { permission }));
        printJsonOrMessage(
          ctx,
          { resource, accessId: flags.accessId, permission, action: "updated" },
          `Updated ${flags.accessId} to ${permission}.`,
        );
        return;
      }
      const principal = await resolvePrincipalForAccess(ctx, flags);
      assertAccessPrincipal(resource, principal);
      const entries = await readApi<AccessEntry[]>(ctx, accessResourcePath(resource));
      const existing = entries.find((entry) => principalKey(entry.principal) === principalKey(principal));
      if (existing) {
        await readApi<MessageResponse>(ctx, `/access/${encodeURIComponent(existing.id)}`, jsonRequest("PATCH", { permission }));
        printJsonOrMessage(
          ctx,
          { resource, accessId: existing.id, permission, action: "updated" },
          `Updated ${existing.id} to ${permission}.`,
        );
        return;
      }
      const created = await readApi<{ accessId: string }>(
        ctx,
        accessResourcePath(resource),
        jsonRequest("POST", { principal, permission }),
      );
      printJsonOrMessage(
        ctx,
        {
          resource,
          principal,
          permission,
          ...created,
          action: "created",
        },
        `Granted ${permission} on ${resource.label}.`,
      );
    },
  }),
  command("access revoke", {
    summary: "Revoke a direct Grids resource grant",
    args: {
      args: arg.rest({ valueLabel: "resource-type refs", description: "Resource type followed by resource refs." }),
    },
    flags: {
      user: flag.string({ description: "User id, uid, email, or exact display name" }),
      group: flag.string({ description: "Group id or exact name" }),
      serviceAccount: flag.string({ name: "service-account", description: "Service account id or exact name" }),
      authenticated: flag.boolean({ description: "Signed-in users" }),
      public: flag.boolean({ description: "Anyone with the link, including anonymous users" }),
      accessId: flag.string({ name: "access-id", description: "Direct access entry id from access list" }),
      yes: confirmFlag("Confirm access revocation"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to revoke access.");
      const resource = await resolveAccessResource(ctx, args.args);
      let accessId = flags.accessId;
      if (!accessId) {
        const principal = await resolvePrincipalForAccess(ctx, flags);
        assertAccessPrincipal(resource, principal);
        const entries = await readApi<AccessEntry[]>(ctx, accessResourcePath(resource));
        const existing = entries.find((entry) => principalKey(entry.principal) === principalKey(principal));
        if (!existing) throw new Error("No direct grant for that principal.");
        accessId = existing.id;
      }
      await readApi<MessageResponse>(ctx, `/access/${encodeURIComponent(accessId)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { resource, accessId, action: "revoked" }, `Revoked ${accessId} on ${resource.label}.`);
    },
  }),
  command("access search-principals", {
    summary: "Search users, groups, and service accounts for grants",
    args: { query: arg.required({ description: "Search text; exact names are safest for grant/set commands." }) },
    flags: {
      kind: flag.stringList({
        separator: ",",
        default: ["user", "group", "service_account"],
        description: "Comma-separated kinds: user, group, service_account",
      }),
      ...paginationFlags({ defaultPerPage: 20, maxPerPage: 100 }),
    },
    async run({ ctx, args, flags }) {
      const allowed = new Set(["user", "group", "service_account"]);
      const kinds = flags.kind.filter((kind): kind is "user" | "group" | "service_account" => allowed.has(kind));
      if (kinds.length !== flags.kind.length) throw new Error("--kind must contain only: user, group, service_account.");
      const payload = await listAccessPrincipalEntities(ctx, {
        search: args.query,
        kinds,
        page: flags.page,
        perPage: flags.perPage,
      });
      if (printCliStructured(ctx, payload)) return;
      ctx.table(
        payload.items.map((item) => {
          if (item.kind === "user") {
            return { kind: "user", name: item.user.displayName, handle: item.user.uid, detail: item.user.mail ?? "", id: item.user.id };
          }
          if (item.kind === "group") {
            return {
              kind: "group",
              name: item.group.name,
              handle: item.group.provider,
              detail: item.group.description ?? "",
              id: item.group.id,
            };
          }
          return {
            kind: "service_account",
            name: item.serviceAccount.name,
            handle: item.serviceAccount.kind,
            detail: item.serviceAccount.appId ?? "",
            id: item.serviceAccount.id,
          };
        }),
        [
          { key: "kind", label: "KIND" },
          { key: "name", label: "NAME" },
          { key: "handle", label: "HANDLE" },
          { key: "id", label: "ID" },
        ],
      );
    },
  }),
];
