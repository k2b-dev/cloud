import { readFile } from "node:fs/promises";
import { arg, type CliInputFlagValue, type CloudCliContext, command, confirmFlag, defineCliCommands, flag, readCliInput } from "./index";

type User = {
  id: string;
  uid: string;
  provider: "ipa" | "local";
  profile: "user" | "guest";
  roles: string[];
  givenname: string;
  sn: string;
  displayName: string;
  mail: string | null;
  memberofGroup: string[];
  manages: string[];
  accountExpires: string | null;
  lastLoginLocal: string | null;
  ipa: null | {
    phone: string | null;
    address: {
      street: string | null;
      postalCode: string | null;
      city: string | null;
      state: string | null;
    };
    passwordExpires: string | null;
    lastLoginIpa: string | null;
    sshPublicKeys: string[];
    sshFingerprints: string[];
  };
};

type ApiKey = {
  id: string;
  name: string;
  status: "active" | "revoked";
  tokenPrefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

type AccountActivity = {
  id: number;
  createdAt: string;
  action: string;
  label: string;
  outcome: "allowed" | "denied" | "failed";
};

type ProfileUpdateFlags = {
  givenName?: string;
  lastName?: string;
  displayName?: string;
  phone?: string;
  street?: string;
  postalCode?: string;
  city?: string;
  state?: string;
};

const apiPath = (path = "") => `/api/me${path === "/" ? "" : path}`;

const readApi = async <T>(ctx: CloudCliContext, path: string, init?: RequestInit): Promise<T> =>
  ctx.readJson<T>(await ctx.fetch(apiPath(path), init));

const jsonRequest = (method: string, value?: unknown): RequestInit => ({
  method,
  headers: value === undefined ? undefined : { "Content-Type": "application/json" },
  body: value === undefined ? undefined : JSON.stringify(value),
});

const printJsonOrTable = <TRow extends Record<string, unknown>>(
  ctx: CloudCliContext,
  value: unknown,
  rows: TRow[],
  columns: Parameters<CloudCliContext["table"]>[1],
) => {
  if (ctx.options.output === "json") ctx.json(value);
  else ctx.table(rows, columns);
};

const parseExpiry = (value: string | undefined): string | null => {
  if (!value) return null;
  const relative = value.match(/^(\d+)([dwmqy])$/i);
  if (relative) {
    const amount = Number.parseInt(relative[1]!, 10);
    const unit = relative[2]!.toLowerCase();
    const days = unit === "d" ? amount : unit === "w" ? amount * 7 : unit === "m" ? amount * 30 : unit === "q" ? amount * 90 : amount * 365;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('--expires must be an ISO timestamp or a duration like "90d".');
  return date.toISOString();
};

const userRows = (user: User) => [
  { key: "uid", value: user.uid },
  { key: "name", value: user.displayName },
  { key: "mail", value: user.mail ?? "" },
  { key: "provider", value: user.provider },
  { key: "profile", value: user.profile },
  { key: "roles", value: user.roles.join(", ") },
];

const profileRows = (user: User) => [
  ...userRows(user),
  { key: "given name", value: user.givenname },
  { key: "last name", value: user.sn },
  { key: "phone", value: user.ipa?.phone ?? "" },
  { key: "street", value: user.ipa?.address.street ?? "" },
  { key: "postal code", value: user.ipa?.address.postalCode ?? "" },
  { key: "city", value: user.ipa?.address.city ?? "" },
  { key: "state", value: user.ipa?.address.state ?? "" },
  { key: "groups", value: user.memberofGroup.join(", ") },
  { key: "manages", value: user.manages.join(", ") },
];

const apiKeyRows = (keys: ApiKey[]) =>
  keys.map((key) => ({
    id: key.id,
    name: key.name,
    prefix: key.tokenPrefix,
    expires: key.expiresAt ?? "never",
    lastUsed: key.lastUsedAt ?? "never",
    created: key.createdAt,
  }));

const activityRows = (items: AccountActivity[]) =>
  items.map((item) => ({
    id: item.id,
    time: item.createdAt,
    outcome: item.outcome,
    action: item.action,
    label: item.label,
  }));

const buildProfileUpdate = (flags: ProfileUpdateFlags) => {
  const data: {
    givenname?: string;
    sn?: string;
    displayName?: string;
    ipa?: {
      phone?: string;
      address?: {
        street?: string;
        postalCode?: string;
        city?: string;
        state?: string;
      };
      sshPublicKeys?: string[];
    };
  } = {};

  if (flags.givenName !== undefined) data.givenname = flags.givenName;
  if (flags.lastName !== undefined) data.sn = flags.lastName;
  if (flags.displayName !== undefined) data.displayName = flags.displayName;

  if ([flags.phone, flags.street, flags.postalCode, flags.city, flags.state].some((value) => value !== undefined)) {
    data.ipa = {};
    if (flags.phone !== undefined) data.ipa.phone = flags.phone;
    if ([flags.street, flags.postalCode, flags.city, flags.state].some((value) => value !== undefined)) {
      data.ipa.address = {};
      if (flags.street !== undefined) data.ipa.address.street = flags.street;
      if (flags.postalCode !== undefined) data.ipa.address.postalCode = flags.postalCode;
      if (flags.city !== undefined) data.ipa.address.city = flags.city;
      if (flags.state !== undefined) data.ipa.address.state = flags.state;
    }
  }

  if (Object.keys(data).length === 0) throw new Error("No profile fields provided.");
  return data;
};

const getCurrentUser = (ctx: CloudCliContext): Promise<User> => readApi<User>(ctx, "/");

const updateProfile = async (ctx: CloudCliContext, data: unknown) => {
  const result = await readApi<{ message: string }>(ctx, "/", jsonRequest("PATCH", data));
  if (ctx.options.output === "json") ctx.json(result);
  else ctx.print(result.message);
};

const resolveApiKey = async (ctx: CloudCliContext, ref: string): Promise<ApiKey> => {
  const { items } = await readApi<{ items: ApiKey[] }>(ctx, "/api-keys");
  const matches = items.filter((key) => key.id === ref || key.tokenPrefix === ref || key.tokenPrefix.startsWith(ref) || key.name === ref);
  if (matches.length === 0) throw new Error(`API key not found: ${ref}`);
  if (matches.length > 1) throw new Error(`API key reference is ambiguous: ${ref}`);
  return matches[0]!;
};

const requireIpaUser = (user: User): NonNullable<User["ipa"]> => {
  if (!user.ipa) throw new Error("SSH keys and address fields are only available for IPA-backed accounts.");
  return user.ipa;
};

const readPublicKey = async (file: string | undefined, valueParts: readonly string[]): Promise<string> => {
  if (file && valueParts.length > 0) throw new Error("Pass either a public key argument or --file, not both.");
  const key = file ? await readFile(file, "utf8") : valueParts.join(" ");
  const trimmed = key.trim();
  if (!trimmed) throw new Error("Missing SSH public key.");
  return trimmed;
};

const removeSshKey = (user: User, ref: string): string[] => {
  const ipa = requireIpaUser(user);
  const matches = ipa.sshPublicKeys
    .map((key, index) => ({ index, key, fingerprint: ipa.sshFingerprints[index] ?? "" }))
    .filter((item) => item.key === ref || item.key.startsWith(ref) || item.fingerprint.startsWith(ref));
  if (matches.length === 0) throw new Error(`SSH key not found: ${ref}`);
  if (matches.length > 1) {
    const candidates = matches.map((item) => `${item.fingerprint || "no fingerprint"} ${item.key.slice(0, 48)}`).join(", ");
    throw new Error(`SSH key reference is ambiguous: ${ref}. Candidates: ${candidates}`);
  }
  const index = matches[0]!.index;
  return ipa.sshPublicKeys.filter((_, keyIndex) => keyIndex !== index);
};

const readRequiredSecret = async (input: CliInputFlagValue, label: string): Promise<string> => {
  const value = await readCliInput(input, { label, required: true, trimFinalNewline: true });
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
};

export default defineCliCommands({
  name: "account",
  summary: "Manage the authenticated account, profile, personal API keys, and SSH keys.",
  groupSummaries: {
    profile: "Show and update the account profile",
    "api-keys": "Manage personal API keys",
    "ssh-keys": "Manage SSH public keys",
    password: "Change the account password",
  },
  commands: [
    command("whoami", {
      summary: "Show the authenticated account",
      run: async ({ ctx }) => {
        const user = await getCurrentUser(ctx);
        printJsonOrTable(ctx, user, userRows(user), [{ key: "key" }, { key: "value" }]);
      },
    }),
    command("profile show", {
      summary: "Show account profile fields",
      run: async ({ ctx }) => {
        const user = await getCurrentUser(ctx);
        printJsonOrTable(ctx, user, profileRows(user), [{ key: "key" }, { key: "value" }]);
      },
    }),
    command("profile set", {
      summary: "Update account profile fields",
      flags: {
        givenName: flag.string({ name: "given-name", aliases: ["givenname"], description: "Given name" }),
        lastName: flag.string({ name: "last-name", aliases: ["sn"], description: "Last name" }),
        displayName: flag.string({ name: "display-name", aliases: ["displayName"], description: "Display name" }),
        phone: flag.string({ description: "Phone number" }),
        street: flag.string({ description: "Street address" }),
        postalCode: flag.string({ name: "postal-code", aliases: ["postalCode"], description: "Postal code" }),
        city: flag.string({ description: "City" }),
        state: flag.string({ description: "State" }),
      },
      run: async ({ ctx, flags }) => {
        await updateProfile(ctx, buildProfileUpdate(flags));
      },
    }),
    command("activity", {
      summary: "List recent account activity",
      flags: {
        days: flag.int({ default: 30, min: 1, max: 3650, description: "Number of days to include" }),
      },
      run: async ({ ctx, flags }) => {
        const result = await readApi<{ items: AccountActivity[] }>(ctx, `/activity?days=${encodeURIComponent(String(flags.days ?? 30))}`);
        printJsonOrTable(ctx, result, activityRows(result.items), [
          { key: "time" },
          { key: "outcome" },
          { key: "action" },
          { key: "label" },
        ]);
      },
    }),
    command("api-keys list", {
      summary: "List personal API keys",
      run: async ({ ctx }) => {
        const result = await readApi<{ items: ApiKey[] }>(ctx, "/api-keys");
        printJsonOrTable(ctx, result, apiKeyRows(result.items), [
          { key: "name" },
          { key: "prefix" },
          { key: "expires" },
          { key: "lastUsed" },
          { key: "id" },
        ]);
      },
    }),
    command("api-keys create", {
      summary: "Create a personal API key",
      args: { name: arg.required({ valueLabel: "name", description: "API key name" }) },
      flags: {
        expires: flag.string({ description: "ISO timestamp or duration like 90d" }),
      },
      run: async ({ ctx, args, flags }) => {
        const result = await readApi<{ credential: ApiKey; token: string }>(
          ctx,
          "/api-keys",
          jsonRequest("POST", { name: args.name, expiresAt: parseExpiry(flags.expires) }),
        );
        if (ctx.options.output === "json") ctx.json(result);
        else ctx.print(`Token: ${result.token}\nPrefix: ${result.credential.tokenPrefix}\nStore this token now. It cannot be shown again.`);
      },
    }),
    command("api-keys revoke", {
      summary: "Revoke a personal API key",
      args: { ref: arg.required({ valueLabel: "id|prefix|name", description: "API key reference" }) },
      flags: { yes: confirmFlag("Confirm API key revocation") },
      run: async ({ ctx, args, flags }) => {
        if (!flags.yes) throw new Error("Refusing to revoke without --yes.");
        const key = await resolveApiKey(ctx, args.ref);
        const result = await readApi<{ message: string }>(ctx, `/api-keys/${encodeURIComponent(key.id)}`, jsonRequest("DELETE"));
        if (ctx.options.output === "json") ctx.json({ ...result, credential: key });
        else ctx.print(result.message);
      },
    }),
    command("ssh-keys list", {
      summary: "List SSH public keys",
      run: async ({ ctx }) => {
        const user = await getCurrentUser(ctx);
        const ipa = requireIpaUser(user);
        const items = ipa.sshPublicKeys.map((key, index) => ({ fingerprint: ipa.sshFingerprints[index] ?? "", key }));
        printJsonOrTable(ctx, { items }, items, [{ key: "fingerprint" }, { key: "key" }]);
      },
    }),
    command("ssh-keys add", {
      summary: "Add an SSH public key",
      args: { publicKey: arg.rest({ valueLabel: "public-key", description: "SSH public key", required: false }) },
      flags: { file: flag.string({ aliases: ["f"], description: "Read SSH public key from file" }) },
      run: async ({ ctx, args, flags }) => {
        const user = await getCurrentUser(ctx);
        const ipa = requireIpaUser(user);
        const key = await readPublicKey(flags.file, args.publicKey);
        if (ipa.sshPublicKeys.includes(key)) throw new Error("SSH public key already exists.");
        await updateProfile(ctx, { ipa: { sshPublicKeys: [...ipa.sshPublicKeys, key] } });
      },
    }),
    command("ssh-keys remove", {
      summary: "Remove an SSH public key",
      args: { ref: arg.required({ valueLabel: "fingerprint|key-prefix", description: "SSH key fingerprint or key prefix" }) },
      run: async ({ ctx, args }) => {
        const user = await getCurrentUser(ctx);
        await updateProfile(ctx, { ipa: { sshPublicKeys: removeSshKey(user, args.ref) } });
      },
    }),
    command("password change", {
      summary: "Change the account password",
      flags: {
        currentPassword: flag.input({
          name: "current-password",
          fileName: "current-password-file",
          stdinName: false,
          required: true,
          description: "Current password or file",
        }),
        newPassword: flag.input({
          name: "new-password",
          fileName: "new-password-file",
          stdinName: false,
          required: true,
          description: "New password or file",
        }),
      },
      run: async ({ ctx, flags }) => {
        const currentPassword = await readRequiredSecret(flags.currentPassword, "current password");
        const newPassword = await readRequiredSecret(flags.newPassword, "new password");
        const result = await readApi<{ message: string }>(
          ctx,
          "/password",
          jsonRequest("POST", { currentPassword, newPassword, confirmPassword: newPassword }),
        );
        if (ctx.options.output === "json") ctx.json(result);
        else ctx.print(result.message);
      },
    }),
    command("extend", {
      summary: "Request account extension",
      run: async ({ ctx }) => {
        const result = await readApi<{ message: string; newExpiry?: string }>(ctx, "/account-extension", jsonRequest("POST"));
        if (ctx.options.output === "json") ctx.json(result);
        else ctx.print(result.newExpiry ? `${result.message} New expiry: ${result.newExpiry}` : result.message);
      },
    }),
  ],
});
