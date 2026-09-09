import { readFile, writeFile } from "node:fs/promises";
import {
  arg,
  type CloudCliContext,
  command,
  cliText,
  confirmFlag,
  defineCliCommands,
  flag,
  paginationFlags,
  printRows as printJsonOrTable,
  printStructured,
} from "@k2b/cloud/cli";

type UserProvider = "local" | "ipa";
type UserProfile = "user" | "guest";
type GroupMemberType = "user" | "group";

type Pagination = {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  has_next: boolean;
};

type BaseUser = {
  id: string;
  uid: string;
  roles: string[];
  provider: UserProvider;
  profile: UserProfile;
  givenname: string;
  sn: string;
  displayName: string;
  mail: string | null;
  avatarHash: string | null;
};

type User = BaseUser & {
  accountExpires: string | null;
  lastLoginLocal: string | null;
  memberofGroup: string[];
  memberofGroupIds: string[];
  manages: string[];
  managesGroupIds: string[];
  ipa: null | {
    uidNumber: number | null;
    phone: string | null;
    employeeType: string | null;
    mobile: string | null;
    address: {
      street: string | null;
      postalCode: string | null;
      city: string | null;
      state: string | null;
    };
    passwordExpires: string | null;
    lastLoginIpa: string | null;
    syncedAt: string | null;
    sshPublicKeys: string[];
    sshFingerprints: string[];
  };
};

type BaseGroup = {
  id: string;
  provider: UserProvider;
  name: string;
  description: string | null;
  gidnumber: number | null;
};

type EntityListItem =
  | { kind: "user"; user: BaseUser; relation?: { direct?: boolean } }
  | { kind: "group"; group: BaseGroup; relation?: { direct?: boolean } }
  | {
      kind: "service_account";
      serviceAccount: {
        id: string;
        name: string;
        kind: "user_delegated" | "resource_bound";
        status: "active" | "disabled";
      };
      relation?: { direct?: boolean };
    };

type UsersResponse = {
  users: BaseUser[];
  pagination: Pagination;
};

type GroupsResponse = {
  groups: BaseGroup[];
  pagination: Pagination;
};

type EntitiesResponse = {
  items: EntityListItem[];
  pagination: Pagination;
};

type MessageResponse = {
  message: string;
};

type UpdateAvatarResponse = MessageResponse & {
  avatarHash: string;
};

type CreateUserResponse = {
  id: string;
  uid: string;
  accountExpires: string | null;
  notificationSent: boolean;
};

type LoginTokenResponse = {
  token: string;
  magicLink: string;
  expiresInSeconds: number;
};

type AccountRequest = {
  id: string;
  userId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  phone: string | null;
  comment: string | null;
  status: "pending" | "completed" | "denied";
  createdAt: string;
};

type RequestsResponse = {
  requests: AccountRequest[];
  pagination: Pagination;
};

type AuditEvent = {
  id: number;
  createdAt: string;
  action: string;
  outcome: "allowed" | "denied" | "failed";
  actor: {
    userId: string | null;
    uid: string | null;
    provider: string | null;
    roles: string[];
  };
  target: {
    type: string | null;
    id: string | null;
    label: string | null;
    provider: string | null;
  };
  reason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
};

type AuditResponse = {
  events: AuditEvent[];
  pagination: Pagination;
};

type ServiceAccountCredential = {
  id: string;
  serviceAccountId: string;
  name: string;
  status: "active" | "revoked";
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  serviceAccount: {
    id: string;
    name: string;
    kind: "user_delegated" | "resource_bound";
    status: "active" | "disabled";
  };
  owner:
    | { type: "user"; userId: string; uid: string; displayName: string; mail: string | null }
    | { type: "resource"; appId: string; resourceType: string; resourceId: string };
};

type ServiceAccountsResponse = {
  credentials: ServiceAccountCredential[];
  pagination: Pagination;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS = ["local", "ipa"] as const;
const PROFILES = ["user", "guest"] as const;
const REQUEST_STATUSES = ["pending", "completed", "denied"] as const;
const REQUEST_SCOPES = ["open", "processed", "all"] as const;
const AUDIT_OUTCOMES = ["allowed", "denied", "failed"] as const;
const AUDIT_ACTION_GROUPS = ["service_accounts"] as const;
const SERVICE_ACCOUNT_KINDS = ["user_delegated", "resource_bound"] as const;
const CREDENTIAL_STATUSES = ["active", "revoked"] as const;

const apiPath = (path = "") => `/api/accounts${path}`;

const encode = (value: string): string => encodeURIComponent(value);

const apiGet = async <T>(ctx: CloudCliContext, path: string): Promise<T> => ctx.readJson<T>(await ctx.fetch(apiPath(path)));

const apiJson = async <T>(ctx: CloudCliContext, method: string, path: string, body?: unknown): Promise<T> =>
  ctx.readJson<T>(
    await ctx.fetch(apiPath(path), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const readErrorResponse = async (ctx: CloudCliContext, response: Response): Promise<never> => {
  await ctx.readJson<unknown>(response);
  throw new Error(`${response.status} ${response.statusText}`);
};

const printMessage = (ctx: CloudCliContext, result: MessageResponse | { message?: string }, fallback: string) => {
  if (!printStructured(ctx, result)) ctx.print(result.message ?? fallback);
};

const compact = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

const queryString = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  const value = search.toString();
  return value ? `?${value}` : "";
};

const pageQuery = (flags: { page?: number; perPage?: number }) => ({
  page: flags.page ?? 1,
  per_page: flags.perPage ?? 50,
});

const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

const truncate = (value: string | null | undefined, max = 80): string => {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
};

const boolChoice = (positive: boolean, negative: boolean, positiveLabel: string, negativeLabel: string): boolean => {
  if (positive && negative) throw new Error(`Pass only one of --${positiveLabel} or --${negativeLabel}.`);
  if (!positive && !negative) throw new Error(`Pass one of --${positiveLabel} or --${negativeLabel}.`);
  return positive;
};

const parseExpiry = (value: string): string | null => {
  if (value === "none" || value === "null" || value === "never" || value === "clear") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Expiry must be an ISO date/date-time, or one of: none, null, never, clear.");
  return value;
};

const avatarMimeFromBytes = (path: string, bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" => {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  throw new Error(`Avatar file "${path}" must be a PNG, JPEG, or WebP image.`);
};

const readAvatarDataUrl = async (flags: { file?: string; dataUrl?: string }): Promise<string> => {
  if (flags.file && flags.dataUrl) throw new Error("Pass only one of --file or --data-url.");
  if (flags.dataUrl) return flags.dataUrl;
  if (!flags.file) throw new Error("Missing avatar input. Pass --file or --data-url.");
  const bytes = await readFile(flags.file);
  const mime = avatarMimeFromBytes(flags.file, bytes);
  return `data:${mime};base64,${bytes.toString("base64")}`;
};

const userRows = (items: BaseUser[]) =>
  items.map((user) => ({
    uid: user.uid,
    name: user.displayName || `${user.givenname} ${user.sn}`.trim(),
    email: user.mail ?? "",
    provider: user.provider,
    profile: user.profile,
    roles: user.roles.join(","),
    id: user.id,
  }));

const groupRows = (items: BaseGroup[]) =>
  items.map((group) => ({
    name: group.name,
    provider: group.provider,
    posix: group.gidnumber === null ? "no" : "yes",
    description: truncate(group.description, 70),
    id: group.id,
  }));

const entityRows = (items: EntityListItem[]) =>
  items.map((item) => {
    if (item.kind === "user") {
      return {
        kind: "user",
        name: item.user.displayName || item.user.uid,
        provider: item.user.provider,
        profile: item.user.profile,
        direct: item.relation?.direct === false ? "no" : "yes",
        id: item.user.id,
      };
    }
    if (item.kind === "group") {
      return {
        kind: "group",
        name: item.group.name,
        provider: item.group.provider,
        profile: "",
        direct: item.relation?.direct === false ? "no" : "yes",
        id: item.group.id,
      };
    }
    return {
      kind: "service_account",
      name: item.serviceAccount.name,
      provider: "",
      profile: item.serviceAccount.status,
      direct: item.relation?.direct === false ? "no" : "yes",
      id: item.serviceAccount.id,
    };
  });

const requestRows = (items: AccountRequest[]) =>
  items.map((request) => ({
    status: request.status,
    email: request.email,
    name: request.displayName || `${request.firstName} ${request.lastName}`.trim(),
    phone: request.phone ?? "",
    createdAt: request.createdAt,
    id: request.id,
  }));

const auditRows = (items: AuditEvent[]) =>
  items.map((event) => ({
    id: event.id,
    createdAt: event.createdAt,
    outcome: event.outcome,
    action: event.action,
    actor: event.actor.uid ?? event.actor.userId ?? "",
    target: event.target.label ?? event.target.id ?? "",
    error: truncate(event.errorMessage ?? event.reason, 72),
  }));

const serviceAccountRows = (items: ServiceAccountCredential[]) =>
  items.map((credential) => ({
    status: credential.status,
    name: credential.name,
    owner: credential.owner.type === "user" ? credential.owner.uid : `${credential.owner.appId}:${credential.owner.resourceType}`,
    kind: credential.serviceAccount.kind,
    prefix: credential.tokenPrefix,
    expiresAt: credential.expiresAt ?? "",
    lastUsedAt: credential.lastUsedAt ?? "",
    id: credential.id,
  }));

const userCandidates = (items: BaseUser[]): string =>
  items
    .slice(0, 5)
    .map((item) => `${item.uid} (${item.id})`)
    .join(", ");

const groupCandidates = (items: BaseGroup[]): string =>
  items
    .slice(0, 5)
    .map((item) => `${item.name} (${item.id})`)
    .join(", ");

const listUsers = (ctx: CloudCliContext, query?: { search?: string; provider?: UserProvider; profile?: UserProfile; page?: number }) =>
  apiGet<UsersResponse>(
    ctx,
    `/users${queryString({
      page: query?.page ?? 1,
      per_page: 100,
      search: query?.search,
      provider: query?.provider,
      profile: query?.profile,
    })}`,
  );

const listGroups = (
  ctx: CloudCliContext,
  query?: { search?: string; provider?: UserProvider; scope?: "all" | "member" | "managed"; page?: number },
) =>
  apiGet<GroupsResponse>(
    ctx,
    `/groups${queryString({
      page: query?.page ?? 1,
      per_page: 100,
      search: query?.search,
      provider: query?.provider,
      scope: query?.scope,
    })}`,
  );

const listEntities = (
  ctx: CloudCliContext,
  query: { search?: string; kinds: "user" | "group"; page?: number; perPage?: number },
): Promise<EntitiesResponse> =>
  apiGet<EntitiesResponse>(
    ctx,
    `/entities${queryString({
      page: query.page ?? 1,
      per_page: query.perPage ?? 100,
      search: query.search,
      kinds: query.kinds,
    })}`,
  );

const resolveUserRef = async (ctx: CloudCliContext, ref: string): Promise<BaseUser> => {
  if (isUuid(ref)) return apiGet<User>(ctx, `/users/${encode(ref)}`);

  let page = 1;
  const seen: BaseUser[] = [];
  const exactMatches: BaseUser[] = [];
  for (;;) {
    const response = await listUsers(ctx, { search: ref, page });
    seen.push(...response.users);
    const matches = response.users.filter((user) => user.uid === ref || user.mail === ref || user.displayName === ref);
    exactMatches.push(...matches);
    if (!response.pagination.has_next) break;
    page += 1;
  }
  if (exactMatches.length === 1) return exactMatches[0]!;
  if (exactMatches.length > 1) throw new Error(`User "${ref}" is ambiguous. Use one of: ${userCandidates(exactMatches)}`);

  const candidates = userCandidates(seen);
  throw new Error(
    candidates
      ? `User "${ref}" was not found by id or exact uid/email/name. Similar matches: ${candidates}`
      : `User "${ref}" was not found.`,
  );
};

const resolveUserIdForGroupRelation = async (ctx: CloudCliContext, ref: string): Promise<string> => {
  if (isUuid(ref)) return ref;

  let page = 1;
  const seen: BaseUser[] = [];
  const exactMatches: BaseUser[] = [];
  for (;;) {
    const response = await listEntities(ctx, { search: ref, kinds: "user", page });
    const users = response.items.flatMap((item) => (item.kind === "user" ? [item.user] : []));
    seen.push(...users);
    const matches = users.filter((user) => user.uid === ref || user.mail === ref || user.displayName === ref);
    exactMatches.push(...matches);
    if (!response.pagination.has_next) break;
    page += 1;
  }
  if (exactMatches.length === 1) return exactMatches[0]!.id;
  if (exactMatches.length > 1) throw new Error(`User "${ref}" is ambiguous. Use one of: ${userCandidates(exactMatches)}`);

  const candidates = userCandidates(seen);
  throw new Error(
    candidates ? `User "${ref}" was not found by exact uid/email/name. Similar matches: ${candidates}` : `User "${ref}" was not found.`,
  );
};

const resolveGroupRef = async (ctx: CloudCliContext, ref: string): Promise<BaseGroup> => {
  let page = 1;
  const seen: BaseGroup[] = [];
  const exactMatches: BaseGroup[] = [];
  for (;;) {
    const response = await listGroups(ctx, { search: isUuid(ref) ? undefined : ref, scope: "all", page });
    seen.push(...response.groups);
    const matches = response.groups.filter((group) => group.id === ref || group.name === ref);
    exactMatches.push(...matches);
    if (isUuid(ref) && exactMatches.length === 1) return exactMatches[0]!;
    if (!response.pagination.has_next) break;
    page += 1;
  }
  if (exactMatches.length === 1) return exactMatches[0]!;
  if (exactMatches.length > 1) throw new Error(`Group "${ref}" is ambiguous. Use one of: ${groupCandidates(exactMatches)}`);

  const candidates = groupCandidates(seen);
  throw new Error(
    candidates ? `Group "${ref}" was not found by id or exact name. Similar matches: ${candidates}` : `Group "${ref}" was not found.`,
  );
};

const resolvePrincipal = async (
  ctx: CloudCliContext,
  flags: { user?: string; group?: string },
  options: { userViaEntities?: boolean } = {},
): Promise<{ type: GroupMemberType; id: string }> => {
  if (flags.user && flags.group) throw new Error("Pass only one of --user or --group.");
  if (!flags.user && !flags.group) throw new Error("Pass one of --user or --group.");
  if (flags.user)
    return {
      type: "user",
      id: options.userViaEntities ? await resolveUserIdForGroupRelation(ctx, flags.user) : (await resolveUserRef(ctx, flags.user)).id,
    };
  return { type: "group", id: (await resolveGroupRef(ctx, flags.group!)).id };
};

const relationEntities = async (
  ctx: CloudCliContext,
  relation: "member_of_group_id" | "manager_of_group_id",
  groupId: string,
  flags: { page?: number; perPage?: number; recursive?: boolean; search?: string; type?: "user" | "group" },
): Promise<EntitiesResponse> =>
  apiGet<EntitiesResponse>(
    ctx,
    `/entities${queryString({
      ...pageQuery(flags),
      search: flags.search,
      kinds: flags.type ?? "user,group",
      [relation]: groupId,
      recursive: flags.recursive,
    })}`,
  );

export default defineCliCommands({
  name: "accounts",
  summary: "Manage accounts, groups, requests, audit events, and service-account credentials.",
  groupSummaries: {
    audit: "Inspect account administration audit events",
    groups: "Create, inspect, and manage groups",
    requests: "Review and resolve account requests",
    "service-accounts": "Inspect and revoke service-account credentials",
    users: "Create, inspect, and manage user accounts",
    "groups managers": "Manage group managers",
    "groups members": "Manage group membership",
    "users avatar": "Download, replace, or remove account avatars",
    "users linux": "Inspect Linux identities and assign missing attributes",
  },
  commands: [
    command("users linux get", {
      summary: "Show Linux identity status and effective defaults",
      args: { user: arg.required() },
      async run({ ctx, args }) {
        const user = await resolveUserRef(ctx, args.user);
        const result = await ctx.readJson(await ctx.fetch(`/api/admin/core/linux-identities/users/${encode(user.id)}`));
        if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
      },
    }),
    command("users linux prepare", {
      summary: "Backfill missing Linux attributes for one existing local full account",
      args: { user: arg.required() },
      flags: { yes: confirmFlag("Confirm assigning missing Linux attributes") },
      async run({ ctx, args, flags }) {
        if (!flags.yes)
          throw new Error(
            cliText(ctx, { en: "Refusing to assign an identity without --yes.", de: "Identität wird ohne --yes nicht zugewiesen." }),
          );
        const user = await resolveUserRef(ctx, args.user);
        const result = await ctx.readJson(await ctx.fetch(`/api/admin/core/linux-identities/users/${encode(user.id)}`, { method: "POST" }));
        if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
      },
    }),
    command("users linux update", {
      summary: "Set home and shell for an existing local Linux identity",
      args: { user: arg.required() },
      flags: {
        home: flag.string({ required: true, description: "Absolute home directory path" }),
        shell: flag.string({ required: true, description: "Absolute login shell path" }),
        yes: confirmFlag("Confirm changing home and shell metadata"),
      },
      async run({ ctx, args, flags }) {
        if (!flags.yes)
          throw new Error(
            cliText(ctx, { en: "Refusing to update an identity without --yes.", de: "Identität wird ohne --yes nicht geändert." }),
          );
        const user = await resolveUserRef(ctx, args.user);
        const result = await ctx.readJson(
          await ctx.fetch(`/api/admin/core/linux-identities/users/${encode(user.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ homeDirectory: flags.home, loginShell: flags.shell }),
          }),
        );
        if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
      },
    }),
    command("users list", {
      summary: "List accounts",
      flags: {
        ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
        search: flag.string({ aliases: ["q"], description: "Search uid, display name, name, or email" }),
        provider: flag.enum(PROVIDERS),
        profile: flag.enum(PROFILES),
      },
      async run({ ctx, flags }) {
        const response = await apiGet<UsersResponse>(
          ctx,
          `/users${queryString({ ...pageQuery(flags), search: flags.search, provider: flags.provider, profile: flags.profile })}`,
        );
        printJsonOrTable(ctx, response, userRows(response.users), [
          { key: "uid" },
          { key: "name" },
          { key: "email" },
          { key: "provider" },
          { key: "profile" },
          { key: "roles" },
          { key: "id" },
        ]);
      },
    }),
    command("users get", {
      summary: "Show one account",
      args: { user: arg.required({ valueLabel: "user" }) },
      async run({ ctx, args }) {
        const user = await resolveUserRef(ctx, args.user);
        const detail = await apiGet<User>(ctx, `/users/${encode(user.id)}`);
        if (!printStructured(ctx, detail)) ctx.print(JSON.stringify(detail, null, 2));
      },
    }),
    command("users create", {
      summary: "Create an account",
      flags: {
        provider: flag.enum(PROVIDERS, { required: true }),
        email: flag.string({ required: true }),
        givenName: flag.string({ name: "given-name", required: true }),
        sn: flag.string({ aliases: ["surname"], required: true, description: "Last name" }),
        displayName: flag.string({ name: "display-name" }),
        profile: flag.enum(PROFILES, { description: "Required for local accounts" }),
        admin: flag.boolean({ description: "Create a local full account with stored admin access" }),
        sendNotification: flag.boolean({ name: "send-notification", description: "Send the standard account-created notification" }),
      },
      async run({ ctx, flags }) {
        if (!flags.provider) throw new Error("Missing required flag --provider.");
        if (!flags.email || !flags.givenName || !flags.sn) throw new Error("Missing required account profile flags.");
        if (flags.provider === "ipa" && flags.profile)
          throw new Error("FreeIPA account profiles are derived from group membership; omit --profile.");
        if (flags.provider === "ipa" && flags.admin)
          throw new Error("FreeIPA admin access is managed through group membership; omit --admin.");
        const body =
          flags.provider === "local"
            ? {
                provider: "local" as const,
                email: flags.email,
                givenname: flags.givenName,
                sn: flags.sn,
                displayName: flags.displayName,
                profile: flags.profile ?? "user",
                admin: flags.admin,
                autoSendNotification: flags.sendNotification,
              }
            : {
                provider: "ipa" as const,
                email: flags.email,
                givenname: flags.givenName,
                sn: flags.sn,
                displayName: flags.displayName,
                autoSendNotification: flags.sendNotification,
              };
        const result = await apiJson<CreateUserResponse>(ctx, "POST", "/users", body);
        printJsonOrTable(
          ctx,
          result,
          [{ uid: result.uid, id: result.id, expires: result.accountExpires ?? "", notified: result.notificationSent }],
          [{ key: "uid" }, { key: "id" }, { key: "expires" }, { key: "notified" }],
        );
      },
    }),
    command("users update", {
      summary: "Update account profile fields",
      args: { user: arg.required({ valueLabel: "user" }) },
      flags: {
        givenName: flag.string({ name: "given-name" }),
        sn: flag.string({ aliases: ["surname"], description: "Last name" }),
        displayName: flag.string({ name: "display-name" }),
        mail: flag.string({ aliases: ["email"] }),
        phone: flag.string({ description: "IPA phone field" }),
      },
      async run({ ctx, args, flags }) {
        const user = await resolveUserRef(ctx, args.user);
        const body = compact({
          givenname: flags.givenName,
          sn: flags.sn,
          displayName: flags.displayName,
          mail: flags.mail,
          ipa: flags.phone === undefined ? undefined : { phone: flags.phone },
        });
        if (Object.keys(body).length === 0) throw new Error("Pass at least one profile field to update.");
        const result = await apiJson<MessageResponse>(ctx, "PATCH", `/users/${encode(user.id)}`, body);
        printMessage(ctx, result, "User updated.");
      },
    }),
    command("users avatar get", {
      summary: "Download an account avatar",
      args: { user: arg.required({ valueLabel: "user" }) },
      flags: {
        out: flag.string({ required: true, aliases: ["output"], description: "Write avatar bytes to this file" }),
      },
      async run({ ctx, args, flags }) {
        if (!flags.out) throw new Error("Missing required flag --out.");
        const user = await resolveUserRef(ctx, args.user);
        const response = await ctx.fetch(apiPath(`/users/${encode(user.id)}/avatar`));
        if (!response.ok) return readErrorResponse(ctx, response);
        const bytes = new Uint8Array(await response.arrayBuffer());
        await writeFile(flags.out, bytes);
        if (!printStructured(ctx, { out: flags.out, bytes: bytes.byteLength, contentType: response.headers.get("content-type") ?? null })) {
          ctx.print(`Wrote ${bytes.byteLength} bytes to ${flags.out}.`);
        }
      },
    }),
    command("users avatar set", {
      summary: "Set an account avatar",
      args: { user: arg.required({ valueLabel: "user" }) },
      flags: {
        file: flag.string({ aliases: ["f"], description: "PNG, JPEG, or WebP image file" }),
        dataUrl: flag.string({ name: "data-url", description: "PNG, JPEG, or WebP data URL" }),
      },
      async run({ ctx, args, flags }) {
        const dataUrl = await readAvatarDataUrl(flags);
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<UpdateAvatarResponse>(ctx, "PUT", `/users/${encode(user.id)}/avatar`, { dataUrl });
        if (!printStructured(ctx, result)) ctx.print(`${result.message} ${result.avatarHash}`);
      },
    }),
    command("users avatar remove", {
      summary: "Remove an account avatar",
      args: { user: arg.required({ valueLabel: "user" }) },
      flags: { yes: confirmFlag("Confirm removing this account avatar") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to remove an avatar without --yes.");
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<MessageResponse>(ctx, "DELETE", `/users/${encode(user.id)}/avatar`);
        printMessage(ctx, result, "Avatar removed.");
      },
    }),
    command("users set-admin", {
      summary: "Grant or revoke stored local admin access",
      description: "The backend rejects IPA and guest accounts; IPA admin access is managed through group membership.",
      args: { user: arg.required({ valueLabel: "user" }) },
      flags: {
        enabled: flag.boolean({ description: "Grant admin access" }),
        disabled: flag.boolean({ description: "Revoke admin access" }),
        yes: confirmFlag("Confirm changing stored local admin access"),
      },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to change admin access without --yes.");
        const admin = boolChoice(flags.enabled, flags.disabled, "enabled", "disabled");
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<MessageResponse>(ctx, "PUT", `/users/${encode(user.id)}/admin`, { admin });
        printMessage(ctx, result, "Admin access updated.");
      },
    }),
    command("users set-profile", {
      summary: "Switch a local account between user and guest",
      args: {
        user: arg.required({ valueLabel: "user" }),
        profile: arg.required({ valueLabel: "profile" }),
      },
      flags: { yes: confirmFlag("Confirm changing the local account profile") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to change account profile without --yes.");
        if (!PROFILES.includes(args.profile as UserProfile)) throw new Error("Profile must be one of: user, guest.");
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<MessageResponse>(ctx, "PUT", `/users/${encode(user.id)}/profile`, { profile: args.profile });
        printMessage(ctx, result, "Account profile updated.");
      },
    }),
    command("users set-provider", {
      summary: "Switch an account between local and FreeIPA providers",
      args: {
        user: arg.required({ valueLabel: "user" }),
        provider: arg.required({ valueLabel: "provider" }),
      },
      flags: { yes: confirmFlag("Confirm switching the account provider") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to switch provider without --yes.");
        if (!PROVIDERS.includes(args.provider as UserProvider)) throw new Error("Provider must be one of: local, ipa.");
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<MessageResponse>(ctx, "PUT", `/users/${encode(user.id)}/provider`, { provider: args.provider });
        printMessage(ctx, result, "Account provider switched.");
      },
    }),
    command("users demote-to-guest", {
      summary: "Demote an IPA account to a local guest account",
      args: { user: arg.required({ valueLabel: "user" }) },
      flags: { yes: confirmFlag("Confirm demoting the IPA account to local guest") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to demote an account without --yes.");
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<MessageResponse>(ctx, "POST", `/users/${encode(user.id)}/demotion`);
        printMessage(ctx, result, "User demoted to guest.");
      },
    }),
    command("users set-expiry", {
      summary: "Set or clear account expiry",
      args: {
        user: arg.required({ valueLabel: "user" }),
        expiry: arg.required({ valueLabel: "expiry" }),
      },
      flags: { yes: confirmFlag("Confirm changing account expiry") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to change account expiry without --yes.");
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<MessageResponse>(ctx, "PUT", `/users/${encode(user.id)}/expiry`, {
          expiryDate: parseExpiry(args.expiry),
        });
        printMessage(ctx, result, "Account expiry updated.");
      },
    }),
    command("users reset-password", {
      summary: "Reset a FreeIPA account password",
      args: { user: arg.required({ valueLabel: "user" }) },
      flags: { yes: confirmFlag("Confirm resetting the FreeIPA password") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to reset a password without --yes.");
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<{ message: string; password: string }>(ctx, "POST", `/users/${encode(user.id)}/password-reset`);
        if (!printStructured(ctx, result)) {
          ctx.print(result.message);
          ctx.print(`Temporary password: ${result.password}`);
        }
      },
    }),
    command("users login-token", {
      summary: "Create a one-time local login token",
      args: { user: arg.required({ valueLabel: "user" }) },
      flags: { yes: confirmFlag("Confirm creating a one-time login token") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to create a login token without --yes.");
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<LoginTokenResponse>(ctx, "POST", `/users/${encode(user.id)}/login-token`);
        if (!printStructured(ctx, result)) {
          ctx.print(`Login token: ${result.token}`);
          ctx.print(`Magic link: ${result.magicLink}`);
          ctx.print(`Expires in: ${result.expiresInSeconds}s`);
        }
      },
    }),
    command("users send-login-link", {
      summary: "Send a local magic login link",
      args: { user: arg.required({ valueLabel: "user" }) },
      flags: { yes: confirmFlag("Confirm sending a login link") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to send a login link without --yes.");
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<MessageResponse>(ctx, "POST", `/users/${encode(user.id)}/login-link`);
        printMessage(ctx, result, "Login link sent.");
      },
    }),
    command("users delete", {
      summary: "Permanently delete an account",
      args: { user: arg.required({ valueLabel: "user" }) },
      flags: { yes: confirmFlag("Confirm permanently deleting this account") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete an account without --yes.");
        const user = await resolveUserRef(ctx, args.user);
        const result = await apiJson<MessageResponse>(ctx, "DELETE", `/users/${encode(user.id)}`);
        printMessage(ctx, result, "User permanently deleted.");
      },
    }),

    command("groups list", {
      summary: "List groups",
      flags: {
        ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
        search: flag.string({ aliases: ["q"], description: "Search group name or description" }),
        provider: flag.enum(PROVIDERS),
        scope: flag.enum(["all", "member", "managed"] as const, { default: "member" }),
      },
      async run({ ctx, flags }) {
        const response = await apiGet<GroupsResponse>(
          ctx,
          `/groups${queryString({ ...pageQuery(flags), search: flags.search, provider: flags.provider, scope: flags.scope })}`,
        );
        printJsonOrTable(ctx, response, groupRows(response.groups), [
          { key: "name" },
          { key: "provider" },
          { key: "posix" },
          { key: "description" },
          { key: "id" },
        ]);
      },
    }),
    command("groups get", {
      summary: "Show one group",
      args: { group: arg.required({ valueLabel: "group" }) },
      async run({ ctx, args }) {
        const group = await resolveGroupRef(ctx, args.group);
        printJsonOrTable(ctx, group, groupRows([group]), [
          { key: "name" },
          { key: "provider" },
          { key: "posix" },
          { key: "description" },
          { key: "id" },
        ]);
      },
    }),
    command("groups create", {
      summary: "Create a group",
      args: { name: arg.required({ valueLabel: "name" }) },
      flags: {
        provider: flag.enum(PROVIDERS, { default: "ipa" }),
        description: flag.string(),
        posix: flag.boolean({ description: "Create a POSIX group where supported" }),
      },
      async run({ ctx, args, flags }) {
        const result = await apiJson<BaseGroup>(ctx, "POST", "/groups", {
          provider: flags.provider,
          name: args.name,
          description: flags.description,
          posix: flags.posix,
        });
        printJsonOrTable(ctx, result, groupRows([result]), [
          { key: "name" },
          { key: "provider" },
          { key: "posix" },
          { key: "description" },
          { key: "id" },
        ]);
      },
    }),
    command("groups update", {
      summary: "Update a group description",
      args: { group: arg.required({ valueLabel: "group" }) },
      flags: { description: flag.string({ required: true }) },
      async run({ ctx, args, flags }) {
        const group = await resolveGroupRef(ctx, args.group);
        const result = await apiJson<MessageResponse>(ctx, "PATCH", `/groups/${encode(group.id)}`, { description: flags.description });
        printMessage(ctx, result, "Group updated.");
      },
    }),
    command("groups make-posix", {
      summary: "Convert a group to POSIX",
      args: { group: arg.required({ valueLabel: "group" }) },
      flags: { yes: confirmFlag("Confirm converting the group to POSIX") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to convert a group to POSIX without --yes.");
        const group = await resolveGroupRef(ctx, args.group);
        if (group.provider === "local") {
          const result = await ctx.readJson(
            await ctx.fetch(`/api/admin/core/linux-identities/groups/${encode(group.id)}`, { method: "POST" }),
          );
          if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
          return;
        }
        const result = await apiJson<MessageResponse>(ctx, "PUT", `/groups/${encode(group.id)}/posix`);
        printMessage(ctx, result, "Group converted to POSIX.");
      },
    }),
    command("groups delete", {
      summary: "Delete a group",
      args: { group: arg.required({ valueLabel: "group" }) },
      flags: { yes: confirmFlag("Confirm deleting this group") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete a group without --yes.");
        const group = await resolveGroupRef(ctx, args.group);
        const result = await apiJson<MessageResponse>(ctx, "DELETE", `/groups/${encode(group.id)}`);
        printMessage(ctx, result, "Group deleted.");
      },
    }),
    command("groups members list", {
      summary: "List group members",
      args: { group: arg.required({ valueLabel: "group" }) },
      flags: {
        ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
        search: flag.string({ aliases: ["q"] }),
        type: flag.enum(["user", "group"] as const),
        recursive: flag.boolean({ description: "Include nested members" }),
      },
      async run({ ctx, args, flags }) {
        const group = await resolveGroupRef(ctx, args.group);
        const response = await relationEntities(ctx, "member_of_group_id", group.id, flags);
        printJsonOrTable(ctx, response, entityRows(response.items), [
          { key: "kind" },
          { key: "name" },
          { key: "provider" },
          { key: "profile" },
          { key: "direct" },
          { key: "id" },
        ]);
      },
    }),
    command("groups members add", {
      summary: "Add a user or group member",
      args: { group: arg.required({ valueLabel: "group" }) },
      flags: {
        user: flag.string({ description: "User id, uid, email, or exact display name" }),
        group: flag.string({ description: "Group id or exact name" }),
        yes: confirmFlag("Confirm adding this group membership"),
      },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to add a group membership without --yes.");
        const group = await resolveGroupRef(ctx, args.group);
        const principal = await resolvePrincipal(ctx, flags, { userViaEntities: true });
        const result = await apiJson<MessageResponse>(ctx, "POST", `/groups/${encode(group.id)}/members`, principal);
        printMessage(ctx, result, "Member added.");
      },
    }),
    command("groups members remove", {
      summary: "Remove a user or group member",
      args: { group: arg.required({ valueLabel: "group" }) },
      flags: {
        user: flag.string({ description: "User id, uid, email, or exact display name" }),
        group: flag.string({ description: "Group id or exact name" }),
        yes: confirmFlag("Confirm removing this group membership"),
      },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to remove a group membership without --yes.");
        const group = await resolveGroupRef(ctx, args.group);
        const principal = await resolvePrincipal(ctx, flags, { userViaEntities: true });
        const result = await apiJson<MessageResponse>(ctx, "DELETE", `/groups/${encode(group.id)}/members`, principal);
        printMessage(ctx, result, "Member removed.");
      },
    }),
    command("groups managers list", {
      summary: "List group managers",
      args: { group: arg.required({ valueLabel: "group" }) },
      flags: {
        ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
        search: flag.string({ aliases: ["q"] }),
        type: flag.enum(["user", "group"] as const),
      },
      async run({ ctx, args, flags }) {
        const group = await resolveGroupRef(ctx, args.group);
        const response = await relationEntities(ctx, "manager_of_group_id", group.id, flags);
        printJsonOrTable(ctx, response, entityRows(response.items), [
          { key: "kind" },
          { key: "name" },
          { key: "provider" },
          { key: "profile" },
          { key: "direct" },
          { key: "id" },
        ]);
      },
    }),
    command("groups managers add", {
      summary: "Add a user or group manager",
      args: { group: arg.required({ valueLabel: "group" }) },
      flags: {
        user: flag.string({ description: "User id, uid, email, or exact display name" }),
        group: flag.string({ description: "Group id or exact name" }),
        yes: confirmFlag("Confirm adding this group manager"),
      },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to add a group manager without --yes.");
        const group = await resolveGroupRef(ctx, args.group);
        const principal = await resolvePrincipal(ctx, flags);
        const result = await apiJson<MessageResponse>(ctx, "POST", `/groups/${encode(group.id)}/managers`, principal);
        printMessage(ctx, result, "Manager added.");
      },
    }),
    command("groups managers remove", {
      summary: "Remove a user or group manager",
      args: { group: arg.required({ valueLabel: "group" }) },
      flags: {
        user: flag.string({ description: "User id, uid, email, or exact display name" }),
        group: flag.string({ description: "Group id or exact name" }),
        yes: confirmFlag("Confirm removing this group manager"),
      },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to remove a group manager without --yes.");
        const group = await resolveGroupRef(ctx, args.group);
        const principal = await resolvePrincipal(ctx, flags);
        const result = await apiJson<MessageResponse>(ctx, "DELETE", `/groups/${encode(group.id)}/managers`, principal);
        printMessage(ctx, result, "Manager removed.");
      },
    }),

    command("requests list", {
      summary: "List account requests",
      flags: {
        ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
        status: flag.enum(REQUEST_STATUSES),
        scope: flag.enum(REQUEST_SCOPES, { default: "open" }),
      },
      async run({ ctx, flags }) {
        const response = await apiGet<RequestsResponse>(
          ctx,
          `/account-requests${queryString({ ...pageQuery(flags), status: flags.status, scope: flags.scope })}`,
        );
        printJsonOrTable(ctx, response, requestRows(response.requests), [
          { key: "status" },
          { key: "email" },
          { key: "name" },
          { key: "phone" },
          { key: "createdAt" },
          { key: "id" },
        ]);
      },
    }),
    command("requests get", {
      summary: "Show one account request",
      args: { request: arg.required({ valueLabel: "request-id" }) },
      async run({ ctx, args }) {
        const request = await apiGet<AccountRequest>(ctx, `/account-requests/${encode(args.request)}`);
        printJsonOrTable(ctx, request, requestRows([request]), [
          { key: "status" },
          { key: "email" },
          { key: "name" },
          { key: "phone" },
          { key: "createdAt" },
          { key: "id" },
        ]);
      },
    }),
    command("requests deny", {
      summary: "Deny a pending account request",
      args: { request: arg.required({ valueLabel: "request-id" }) },
      flags: {
        reason: flag.string({ description: "Optional denial reason; sends an email when provided" }),
        yes: confirmFlag("Confirm denying this account request"),
      },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to deny an account request without --yes.");
        const result = await apiJson<MessageResponse>(ctx, "POST", `/account-requests/${encode(args.request)}/deny`, {
          reason: flags.reason,
        });
        printMessage(ctx, result, "Request denied.");
      },
    }),

    command("audit list", {
      summary: "List Accounts audit events",
      flags: {
        ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
        search: flag.string({ aliases: ["q"] }),
        actor: flag.string(),
        target: flag.string(),
        action: flag.string(),
        actionGroup: flag.enum(AUDIT_ACTION_GROUPS, { name: "action-group" }),
        serviceAccountId: flag.string({ name: "service-account-id" }),
        outcome: flag.enum(AUDIT_OUTCOMES),
        provider: flag.enum(PROVIDERS),
        days: flag.int({ min: 1, max: 3650 }),
      },
      async run({ ctx, flags }) {
        const response = await apiGet<AuditResponse>(
          ctx,
          `/audit${queryString({
            ...pageQuery(flags),
            search: flags.search,
            actor: flags.actor,
            target: flags.target,
            action: flags.action,
            actionGroup: flags.actionGroup,
            serviceAccountId: flags.serviceAccountId,
            outcome: flags.outcome,
            provider: flags.provider,
            days: flags.days,
          })}`,
        );
        printJsonOrTable(ctx, response, auditRows(response.events), [
          { key: "id" },
          { key: "createdAt" },
          { key: "outcome" },
          { key: "action" },
          { key: "actor" },
          { key: "target" },
          { key: "error" },
        ]);
      },
    }),

    command("service-accounts list", {
      summary: "List service-account API keys",
      flags: {
        ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
        search: flag.string({ aliases: ["q"] }),
        kind: flag.enum(SERVICE_ACCOUNT_KINDS),
        status: flag.enum(CREDENTIAL_STATUSES),
        user: flag.string({ description: "Filter user-delegated keys by user id, uid, email, or exact display name" }),
        userId: flag.string({ name: "user-id" }),
      },
      async run({ ctx, flags }) {
        if (flags.user && flags.userId) throw new Error("Pass only one of --user or --user-id.");
        const userId = flags.user ? (await resolveUserRef(ctx, flags.user)).id : flags.userId;
        const response = await apiGet<ServiceAccountsResponse>(
          ctx,
          `/service-accounts${queryString({
            ...pageQuery(flags),
            search: flags.search,
            kind: flags.kind,
            status: flags.status,
            userId,
          })}`,
        );
        printJsonOrTable(ctx, response, serviceAccountRows(response.credentials), [
          { key: "status" },
          { key: "name" },
          { key: "owner" },
          { key: "kind" },
          { key: "prefix" },
          { key: "expiresAt" },
          { key: "lastUsedAt" },
          { key: "id" },
        ]);
      },
    }),
    command("service-accounts revoke", {
      summary: "Revoke a service-account API key",
      args: { credential: arg.required({ valueLabel: "credential-id" }) },
      flags: { yes: confirmFlag("Confirm revoking this service-account API key") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to revoke a service-account API key without --yes.");
        const result = await apiJson<MessageResponse>(ctx, "DELETE", `/service-accounts/credentials/${encode(args.credential)}`);
        printMessage(ctx, result, "API key revoked.");
      },
    }),
  ],
});
