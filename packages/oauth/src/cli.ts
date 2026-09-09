import {
  arg,
  type CloudCliContext,
  command,
  confirmFlag,
  defineCliCommands,
  flag,
  printRows as printJsonOrTable,
  printStructured,
} from "@k2b/cloud/cli";
import type {
  OAuthAccessMode,
  OAuthAllowedProfile,
  OAuthClient,
  OAuthClientListResponse,
  OAuthScope,
  UpdateOAuthClient,
} from "./contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES: readonly OAuthScope[] = ["openid", "profile", "email", "groups", "offline_access", "read", "write", "admin"];
const PROFILES: readonly OAuthAllowedProfile[] = ["user", "guest"];
const ACCESS_MODES: readonly OAuthAccessMode[] = ["profiles", "specific"];

const apiPath = (path = "") => `/api/oauth/admin/clients${path}`;

const apiGet = async <T>(ctx: CloudCliContext, path: string): Promise<T> => ctx.readJson<T>(await ctx.fetch(apiPath(path)));

const apiJson = async <T>(ctx: CloudCliContext, method: string, path: string, body?: unknown): Promise<T> =>
  ctx.readJson<T>(
    await ctx.fetch(apiPath(path), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const compact = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

const formatArray = (values: readonly string[]) => values.join(",");

const clientRows = (clients: OAuthClient[]) =>
  clients.map((client) => ({
    id: client.id,
    name: client.name,
    clientId: client.clientId,
    type: client.isPublic ? "public" : "confidential",
    scopes: formatArray(client.scopes),
    access: client.accessMode,
    redirects: client.redirectUris.length,
  }));

const listClients = async (
  ctx: CloudCliContext,
  params: { page?: number; perPage?: number; search?: string } = {},
): Promise<OAuthClientListResponse> => {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    per_page: String(params.perPage ?? 100),
  });
  if (params.search) query.set("search", params.search);
  return apiGet<OAuthClientListResponse>(ctx, `?${query}`);
};

const resolveClient = async (ctx: CloudCliContext, ref: string): Promise<OAuthClient> => {
  if (UUID_PATTERN.test(ref)) return apiGet<OAuthClient>(ctx, `/${encodeURIComponent(ref)}`);

  const matches: OAuthClient[] = [];
  let page = 1;
  while (matches.length < 2) {
    const result = await listClients(ctx, { page, search: ref });
    matches.push(...result.clients.filter((client) => client.clientId === ref || client.name === ref));
    if (!result.pagination.has_next) break;
    page += 1;
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`OAuth client "${ref}" is ambiguous. Use one of: ${matches.map((item) => item.id).join(", ")}`);
  throw new Error(`OAuth client "${ref}" was not found by id, client id, or exact name.`);
};

const createInput = (flags: {
  name: string;
  description?: string;
  redirectUri: string[];
  logoutUri?: string;
  scope: OAuthScope[];
  audience: string[];
  serviceAccountId?: string;
  profile: OAuthAllowedProfile[];
  accessMode?: OAuthAccessMode;
  allowedUserId: string[];
  allowedGroupId: string[];
  public: boolean;
}): { name: string } & Record<string, unknown> => ({
  name: flags.name,
  ...compact({
    description: flags.description,
    redirectUris: flags.redirectUri.length > 0 ? flags.redirectUri : undefined,
    logoutUri: flags.logoutUri,
    scopes: flags.scope.length > 0 ? flags.scope : undefined,
    audiences: flags.audience.length > 0 ? flags.audience : undefined,
    serviceAccountId: flags.serviceAccountId,
    allowedProfiles: flags.profile.length > 0 ? flags.profile : undefined,
    accessMode: flags.accessMode,
    allowedUserIds: flags.allowedUserId.length > 0 ? flags.allowedUserId : undefined,
    allowedGroupIds: flags.allowedGroupId.length > 0 ? flags.allowedGroupId : undefined,
    isPublic: flags.public ? true : undefined,
  }),
});

const updateInput = (flags: {
  name?: string;
  description?: string;
  clearDescription: boolean;
  redirectUri: string[];
  clearRedirectUris: boolean;
  logoutUri?: string;
  clearLogoutUri: boolean;
  scope: OAuthScope[];
  audience: string[];
  clearAudiences: boolean;
  serviceAccountId?: string;
  clearServiceAccount: boolean;
  profile: OAuthAllowedProfile[];
  accessMode?: OAuthAccessMode;
  allowedUserId: string[];
  clearAllowedUsers: boolean;
  allowedGroupId: string[];
  clearAllowedGroups: boolean;
}): UpdateOAuthClient =>
  compact({
    name: flags.name,
    description: flags.clearDescription ? null : flags.description,
    redirectUris: flags.clearRedirectUris ? [] : flags.redirectUri.length > 0 ? flags.redirectUri : undefined,
    logoutUri: flags.clearLogoutUri ? null : flags.logoutUri,
    scopes: flags.scope.length > 0 ? flags.scope : undefined,
    audiences: flags.clearAudiences ? [] : flags.audience.length > 0 ? flags.audience : undefined,
    serviceAccountId: flags.clearServiceAccount ? null : flags.serviceAccountId,
    allowedProfiles: flags.profile.length > 0 ? flags.profile : undefined,
    accessMode: flags.accessMode,
    allowedUserIds: flags.clearAllowedUsers ? [] : flags.allowedUserId.length > 0 ? flags.allowedUserId : undefined,
    allowedGroupIds: flags.clearAllowedGroups ? [] : flags.allowedGroupId.length > 0 ? flags.allowedGroupId : undefined,
  });

export default defineCliCommands({
  name: "oauth",
  summary: "Manage OAuth clients.",
  groupSummaries: {
    clients: "Create, inspect, and manage OAuth clients",
  },
  commands: [
    command("clients list", {
      summary: "List OAuth clients",
      flags: {
        page: flag.int({ min: 1, description: "Page number" }),
        perPage: flag.int({ name: "per-page", aliases: ["per_page"], min: 1, max: 100, description: "Items per page" }),
        search: flag.string({ description: "Search name, client ID, or description" }),
      },
      async run({ ctx, flags }) {
        const { clients } = await listClients(ctx, { page: flags.page, perPage: flags.perPage, search: flags.search });
        printJsonOrTable(ctx, clients, clientRows(clients), [
          { key: "name" },
          { key: "clientId", label: "Client ID" },
          { key: "type" },
          { key: "scopes" },
          { key: "access" },
          { key: "redirects" },
          { key: "id" },
        ]);
      },
    }),
    command("clients get", {
      summary: "Show an OAuth client",
      args: { client: arg.required({ valueLabel: "client" }) },
      async run({ ctx, args }) {
        const client = await resolveClient(ctx, args.client);
        if (!printStructured(ctx, client)) ctx.print(JSON.stringify(client, null, 2));
      },
    }),
    command("clients create", {
      summary: "Create an OAuth client",
      flags: {
        name: flag.string({ required: true, description: "Client name" }),
        description: flag.string({ description: "Client description" }),
        redirectUri: flag.stringList({ name: "redirect-uri", description: "Allowed redirect URI. Repeat or comma-separate." }),
        logoutUri: flag.string({ name: "logout-uri", description: "Post-logout redirect URI" }),
        scope: flag.stringList({ description: `Allowed scopes: ${SCOPES.join(", ")}` }) as ReturnType<typeof flag.stringList>,
        audience: flag.stringList({ description: "Allowed token audience. Repeat or comma-separate." }),
        serviceAccountId: flag.string({ name: "service-account-id", description: "Linked service account id" }),
        profile: flag.stringList({ description: `Allowed profiles: ${PROFILES.join(", ")}` }) as ReturnType<typeof flag.stringList>,
        accessMode: flag.enum(ACCESS_MODES, { name: "access-mode", description: "Client access mode" }),
        allowedUserId: flag.stringList({ name: "allowed-user-id", description: "Allowed user id. Repeat or comma-separate." }),
        allowedGroupId: flag.stringList({ name: "allowed-group-id", description: "Allowed group id. Repeat or comma-separate." }),
        public: flag.boolean({ description: "Create a public client without a secret" }),
      },
      async run({ ctx, flags }) {
        if (!flags.name) throw new Error("Missing required flag --name.");
        const scopes = flags.scope.filter((item): item is OAuthScope => SCOPES.includes(item as OAuthScope));
        const profiles = flags.profile.filter((item): item is OAuthAllowedProfile => PROFILES.includes(item as OAuthAllowedProfile));
        if (flags.scope.length !== scopes.length) throw new Error(`--scope must be one of: ${SCOPES.join(", ")}.`);
        if (flags.profile.length !== profiles.length) throw new Error(`--profile must be one of: ${PROFILES.join(", ")}.`);
        const input = createInput({
          ...flags,
          name: flags.name,
          scope: scopes,
          profile: profiles,
        });

        const client = await apiJson<OAuthClient & { clientSecret?: string }>(ctx, "POST", "", input);
        if (!printStructured(ctx, client)) {
          ctx.print(`Created ${client.name} (${client.clientId})`);
          if (client.clientSecret) ctx.print(`Client secret: ${client.clientSecret}`);
        }
      },
    }),
    command("clients update", {
      summary: "Update an OAuth client",
      args: { client: arg.required({ valueLabel: "client" }) },
      flags: {
        name: flag.string(),
        description: flag.string(),
        clearDescription: flag.boolean({ name: "clear-description" }),
        redirectUri: flag.stringList({ name: "redirect-uri" }),
        clearRedirectUris: flag.boolean({ name: "clear-redirect-uris" }),
        logoutUri: flag.string({ name: "logout-uri" }),
        clearLogoutUri: flag.boolean({ name: "clear-logout-uri" }),
        scope: flag.stringList(),
        audience: flag.stringList(),
        clearAudiences: flag.boolean({ name: "clear-audiences" }),
        serviceAccountId: flag.string({ name: "service-account-id" }),
        clearServiceAccount: flag.boolean({ name: "clear-service-account" }),
        profile: flag.stringList(),
        accessMode: flag.enum(ACCESS_MODES, { name: "access-mode" }),
        allowedUserId: flag.stringList({ name: "allowed-user-id" }),
        clearAllowedUsers: flag.boolean({ name: "clear-allowed-users" }),
        allowedGroupId: flag.stringList({ name: "allowed-group-id" }),
        clearAllowedGroups: flag.boolean({ name: "clear-allowed-groups" }),
      },
      async run({ ctx, args, flags }) {
        const client = await resolveClient(ctx, args.client);
        const input = updateInput({
          ...flags,
          scope: flags.scope.filter((item): item is OAuthScope => SCOPES.includes(item as OAuthScope)),
          profile: flags.profile.filter((item): item is OAuthAllowedProfile => PROFILES.includes(item as OAuthAllowedProfile)),
        });
        if (flags.scope.length !== input.scopes?.length && flags.scope.length > 0)
          throw new Error(`--scope must be one of: ${SCOPES.join(", ")}.`);
        if (flags.profile.length !== input.allowedProfiles?.length && flags.profile.length > 0)
          throw new Error(`--profile must be one of: ${PROFILES.join(", ")}.`);
        await apiJson(ctx, "PUT", `/${encodeURIComponent(client.id)}`, input);
        ctx.print(`Updated ${flags.name ?? client.name}`);
      },
    }),
    command("clients delete", {
      summary: "Delete an OAuth client",
      args: { client: arg.required({ valueLabel: "client" }) },
      flags: { yes: confirmFlag("Delete the OAuth client") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete without --yes.");
        const client = await resolveClient(ctx, args.client);
        await apiJson(ctx, "DELETE", `/${encodeURIComponent(client.id)}`);
        ctx.print(`Deleted ${client.name}`);
      },
    }),
    command("clients regenerate-secret", {
      summary: "Regenerate a confidential client's secret",
      args: { client: arg.required({ valueLabel: "client" }) },
      flags: { yes: confirmFlag("Regenerate the client secret") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to regenerate a secret without --yes.");
        const client = await resolveClient(ctx, args.client);
        const result = await apiJson<{ clientSecret: string }>(ctx, "POST", `/${encodeURIComponent(client.id)}/regenerate-secret`);
        if (!printStructured(ctx, result)) ctx.print(`Client secret: ${result.clientSecret}`);
      },
    }),
  ],
});
