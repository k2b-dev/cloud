import { type CloudCliContext, command, flag, readCliInput } from "@k2b/cloud/cli";
import { storeFixHint } from "../frontend/admin/messages";
import type { StoreCheckResult } from "../store/check";
import type { StoreStatus } from "../store/contracts";
import { StorePassword, StoreSaveInput, StoreUser } from "../store/validation";
import { jsonRequest, printJsonOrTable } from "./shared";

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
const request = async <T>(ctx: CloudCliContext, path = "", init?: RequestInit): Promise<T> => {
  const response = await ctx.fetch(`/api/pulse/admin/store${path}`, init);
  const value = await response.json();
  if (!response.ok) {
    if (value?.code === "STORE_CHECK_FAILED" && value.status) reportCheck(ctx, value.status);
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
