import { arg, type CloudCliContext, command, flag, readCliInput } from "@k2b/cloud/cli";
import { z } from "zod";
import { storeFixHint } from "../frontend/admin/messages";
import { ADMIN_ERROR_CODES } from "../store/admin-contracts";
import { AdminBaseRowSchema, LimitsUpdateSchema, PulsePolicyUpdateSchema } from "../store/admin-schemas";
import type { StoreCheckResult } from "../store/check-codes";
import type { StoreStatus } from "../store/contracts";
import { StorePassword, StoreSaveInput, StoreUser } from "../store/validation";
import { jsonRequest, printJsonOrTable, printStructured } from "./shared";

const passwordFlags = {
  passwordFile: flag.string({ name: "password-file", description: "Read the password from a file" }),
  passwordStdin: flag.boolean({ name: "password-stdin", description: "Read the password from stdin" }),
};
const readPassword = async (flags: { passwordFile?: string; passwordStdin: boolean }, required = false) => {
  if (flags.passwordFile && flags.passwordStdin) throw new Error("Pass only one of --password-file or --password-stdin.");
  let password: string | undefined;
  try {
    password = await readCliInput(
      flags.passwordFile
        ? { source: "file", file: flags.passwordFile, provided: true }
        : flags.passwordStdin
          ? { source: "stdin", provided: true }
          : { source: null, provided: false },
      { required, trimFinalNewline: true },
    );
  } catch {
    throw new Error("Could not read the password. Use --password-file or --password-stdin.");
  }
  if (password !== undefined && !StorePassword.safeParse(password).success)
    throw new Error("Password must be 1–256 characters without control characters.");
  return password;
};
/** Request refusals the store API answers with a fixed code; the CLI names them with the page's fix hint. */
const REQUEST_CODES = new Set(["PASSWORD_REQUIRED", "STORE_BUSY", "INVALID_INPUT", "STORE_NOT_CONFIGURED"]);
const request = async <T>(ctx: CloudCliContext, path = "", init?: RequestInit): Promise<T> => {
  const response = await ctx.fetch(`/api/pulse/admin/store${path}`, init);
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    if (value?.code === "STORE_CHECK_FAILED" && value.status) reportCheck(ctx, value.status);
    if (typeof value?.code === "string" && REQUEST_CODES.has(value.code))
      throw new Error(`${value.code}: ${storeFixHint(value.code, ctx.options.locale)}`);
    // Fixed errors only; never relay a remote message containing request data.
    throw new Error(`Pulse store request failed (${response.status}).`);
  }
  return value;
};
const reportCheck = (ctx: CloudCliContext, status: StoreCheckResult) => {
  printJsonOrTable(
    ctx,
    status,
    Object.entries(status.steps).map(([step, state]) => ({ step, state })),
    [{ key: "step" }, { key: "state" }],
  );
  if (!status.ok) throw new Error(`${status.code ?? "UNREACHABLE"}: ${storeFixHint(status.code ?? "UNREACHABLE", ctx.options.locale)}`);
};
export const adminCommands = [
  command("admin store get", {
    summary: "Read Pulse store configuration and connection status",
    async run({ ctx }) {
      const value = await request<StoreStatus>(ctx);
      printJsonOrTable(
        ctx,
        value,
        [
          {
            ...value,
            status: value.status?.code ?? (value.status?.ok ? "connected" : "not configured"),
            version: value.status?.version ?? "-",
            latencyMs: value.status?.latencyMs ?? "-",
            checkedAt: value.status?.checkedAt ?? "-",
          },
        ],
        [
          { key: "configured" },
          { key: "url" },
          { key: "user" },
          { key: "passwordSet" },
          { key: "status" },
          { key: "version" },
          { key: "latencyMs" },
          { key: "checkedAt" },
        ],
      );
    },
  }),
  command("admin store set", {
    summary: "Check and connect the Pulse data store",
    flags: {
      url: flag.string({ required: true, description: "ClickHouse HTTP or HTTPS origin" }),
      user: flag.string({ description: "Service user (default: saved user or pulse_service)" }),
      ...passwordFlags,
    },
    async run({ ctx, flags }) {
      const password = await readPassword(flags);
      const user = flags.user ?? (await request<StoreStatus>(ctx)).user;
      const input = StoreSaveInput.safeParse({ url: flags.url, user, password });
      if (!input.success) throw new Error("Invalid store address, service user, or password.");
      const value = await request<StoreStatus>(ctx, "", jsonRequest("PUT", input.data));
      if (value.status) reportCheck(ctx, value.status);
    },
  }),
  command("admin store check", {
    summary: "Check Pulse store access rights and profiles",
    async run({ ctx }) {
      reportCheck(ctx, await request<StoreCheckResult>(ctx, "/check", jsonRequest("POST")));
    },
  }),
  command("admin store setup-sql", {
    summary: "Print the ClickHouse admin setup script with a salted password hash",
    flags: {
      user: flag.string({ description: "Service user (default: saved user or pulse_service)" }),
      ...passwordFlags,
    },
    async run({ ctx, flags }) {
      const password = await readPassword(flags, true);
      if (flags.user !== undefined && !StoreUser.safeParse(flags.user).success) throw new Error("Invalid service user.");
      const value = await request<{ sql: string }>(ctx, "/setup-sql", jsonRequest("POST", { user: flags.user, password }));
      await ctx.write(value.sql);
    },
  }),
];

const pageFlags = {
  limit: flag.int({ min: 1, max: 100, description: "Page size (default 50)" }),
  offset: flag.int({ min: 0, description: "Page offset" }),
};
const limitFlags = {
  valuesPerMinute: flag.int({ name: "values-per-minute", min: 1, description: "Values per minute" }),
  bytesPerMinute: flag.int({ name: "bytes-per-minute", min: 1, description: "Bytes per minute" }),
  storageBytes: flag.int({ name: "storage-bytes", min: 1, description: "Storage threshold in bytes" }),
  maxSeries: flag.int({ name: "max-series", min: 1, description: "Maximum series" }),
  maxEventKinds: flag.int({ name: "max-event-kinds", min: 1, description: "Maximum event kinds" }),
  maxStateKeys: flag.int({ name: "max-state-keys", min: 1, description: "Maximum state keys" }),
};
const adminRequest = async (ctx: CloudCliContext, path: string, init?: RequestInit) => {
  const response = await ctx.fetch(`/api/pulse/admin${path}`, init);
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ code: z.enum(ADMIN_ERROR_CODES) }).safeParse(value);
    throw new Error(
      `${parsed.success ? parsed.data.code : "ADMIN_REQUEST_FAILED"}: A Cloud admin can review this under Administration -> Pulse. Check the input and retry.`,
    );
  }
  return value;
};
const show = (ctx: CloudCliContext, value: unknown) => {
  if (!printStructured(ctx, value)) ctx.print(JSON.stringify(value, null, 2));
};
const queryString = (values: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) q.set(key, String(value));
  return q.size ? `?${q}` : "";
};
const baseArg = { baseId: arg.required({ valueLabel: "baseId", description: "Public base ID" }) };
adminCommands.push(
  command("admin policy get", {
    summary: "Read base creation policy and defaults",
    async run({ ctx }) {
      show(ctx, await adminRequest(ctx, "/policy"));
    },
  }),
  command("admin policy set", {
    summary: "Change base policy and defaults",
    flags: {
      baseCreation: flag.string({ name: "base-creation", description: "everyone, people or admins" }),
      maxBases: flag.int({ name: "max-bases", min: 1, description: "Maximum bases" }),
      maxRawRetentionDays: flag.int({ name: "max-raw-retention-days", min: 1, max: 3650, description: "Maximum raw retention" }),
      defaultProfile: flag.string({ name: "default-profile", description: "small, normal or large" }),
      defaultValuesPerMinute: flag.int({ name: "default-values-per-minute", min: 1, description: "Default values per minute" }),
      defaultBytesPerMinute: flag.int({ name: "default-bytes-per-minute", min: 1, description: "Default bytes per minute" }),
      defaultStorageBytes: flag.int({ name: "default-storage-bytes", min: 1, description: "Default storage bytes" }),
      defaultMaxSeries: flag.int({ name: "default-max-series", min: 1, description: "Default maximum series" }),
      defaultMaxEventKinds: flag.int({ name: "default-max-event-kinds", min: 1, description: "Default maximum event kinds" }),
      defaultMaxStateKeys: flag.int({ name: "default-max-state-keys", min: 1, description: "Default maximum state keys" }),
    },
    async run({ ctx, flags }) {
      const body = PulsePolicyUpdateSchema.parse({
        baseCreation: flags.baseCreation,
        maxBases: flags.maxBases,
        maxRawRetentionDays: flags.maxRawRetentionDays,
        defaultProfile: flags.defaultProfile,
        defaultLimits: {
          valuesPerMinute: flags.defaultValuesPerMinute,
          bytesPerMinute: flags.defaultBytesPerMinute,
          storageBytes: flags.defaultStorageBytes,
          maxSeries: flags.defaultMaxSeries,
          maxEventKinds: flags.defaultMaxEventKinds,
          maxStateKeys: flags.defaultMaxStateKeys,
        },
      });
      show(ctx, await adminRequest(ctx, "/policy", jsonRequest("PUT", body)));
    },
  }),
  command("admin bases list", {
    summary: "List base store states and amounts",
    flags: { ...pageFlags, query: flag.string({ description: "Search base names" }) },
    async run({ ctx, flags }) {
      show(ctx, await adminRequest(ctx, `/bases${queryString({ limit: flags.limit, offset: flags.offset, q: flags.query })}`));
    },
  }),
  command("admin bases limits", {
    summary: "Show or change a base profile and limits",
    args: baseArg,
    flags: { ...limitFlags, profile: flag.string({ description: "small, normal or large" }) },
    async run({ ctx, args, flags }) {
      const { profile, ...limits } = flags;
      if (Object.values(flags).every((value) => value === undefined)) {
        const result = z
          .object({ items: z.array(AdminBaseRowSchema) })
          .parse(await adminRequest(ctx, `/bases${queryString({ q: args.baseId })}`));
        const row = result.items.find((base) => base.id === args.baseId);
        if (!row) throw new Error("NOT_FOUND: Check the base ID under Administration -> Pulse -> Bases.");
        show(ctx, row);
        return;
      }
      const body = LimitsUpdateSchema.parse({ profile, limits });
      show(ctx, await adminRequest(ctx, `/bases/${encodeURIComponent(args.baseId)}/limits`, jsonRequest("PUT", body)));
    },
  }),
  ...(["retry", "recheck", "recreate"] as const).map((action) =>
    command(`admin bases ${action}`, {
      summary: `${action} a base store`,
      args: baseArg,
      async run({ ctx, args }) {
        show(ctx, await adminRequest(ctx, `/bases/${encodeURIComponent(args.baseId)}/${action}`, jsonRequest("POST")));
      },
    }),
  ),
  command("admin orphans list", {
    summary: "List databases without a base",
    flags: {
      limit: pageFlags.limit,
      after: flag.string({ description: "Continue after the previous page's nextCursor" }),
    },
    async run({ ctx, flags }) {
      show(ctx, await adminRequest(ctx, `/orphans${queryString(flags)}`));
    },
  }),
  command("admin orphans delete", {
    summary: "Delete a database without a base",
    args: { database: arg.required({ valueLabel: "database" }) },
    async run({ ctx, args }) {
      show(ctx, await adminRequest(ctx, `/orphans/${encodeURIComponent(args.database)}`, jsonRequest("DELETE")));
    },
  }),
  command("admin targets list", {
    summary: "List released internal targets",
    flags: { ...pageFlags, base: flag.string({ description: "Public base ID" }) },
    async run({ ctx, flags }) {
      show(ctx, await adminRequest(ctx, `/targets${queryString({ limit: flags.limit, offset: flags.offset, baseId: flags.base })}`));
    },
  }),
  command("admin targets add", {
    summary: "Release an internal target for a base",
    args: { entry: arg.required({ valueLabel: "entry" }) },
    flags: { base: flag.string({ required: true, description: "Public base ID" }) },
    async run({ ctx, args, flags }) {
      show(ctx, await adminRequest(ctx, "/targets", jsonRequest("POST", { baseId: flags.base, entry: args.entry })));
    },
  }),
  command("admin targets remove", {
    summary: "Revoke an internal target",
    args: { targetId: arg.required({ valueLabel: "targetId" }) },
    async run({ ctx, args }) {
      show(ctx, await adminRequest(ctx, `/targets/${encodeURIComponent(args.targetId)}`, jsonRequest("DELETE")));
    },
  }),
);
