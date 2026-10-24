import type { AccessEntry } from "../contracts/shared";
import type { AppAccessChange, AppAccessSnapshot } from "../services/app-access-management";
import { createAccessCommands } from "./access";
import { flag } from "./commands";
import type { CloudCliContext } from "./index";

/** Add to an app's CLI module; the same audited access API serves the editor and these commands. */
export const createAppAccessCommands = (appId: string) => {
  const path = `/_cloud/app-access/${encodeURIComponent(appId)}`;
  const change = async (ctx: CloudCliContext, input: AppAccessChange) =>
    ctx.readJson<{ entry?: AccessEntry; canUse: boolean }>(
      await ctx.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  const commands = createAccessCommands({
    resourceLabel: "app",
    allowedPermissions: ["read", "admin"],
    allowAuthenticated: true,
    allowPublic: false,
    allowServiceAccounts: true,
    resolveResource: async (_ctx, args) => {
      if (args.length) throw new Error("App access takes no resource argument.");
      return { id: appId, label: appId };
    },
    list: async (ctx) => (await ctx.readJson<AppAccessSnapshot>(await ctx.fetch(path))).entries,
    grant: async (ctx, _resource, principal, permission) => {
      if (permission !== "read" && permission !== "admin") throw new Error("App permissions are use or manage.");
      const result = await change(ctx, { action: "grant", principal, permission });
      if (!result.entry) throw new Error("The access change returned no entry. Read the list before retrying.");
      return result.entry;
    },
    update: async (ctx, _resource, accessId, permission) => {
      if (permission !== "read" && permission !== "admin") throw new Error("App permissions are use or manage.");
      await change(ctx, { action: "update", accessId, permission });
    },
    revoke: async (ctx, _resource, accessId) => {
      await change(ctx, { action: "revoke", accessId });
    },
  });
  // Product vocabulary at the CLI boundary; stored permission levels remain read/admin.
  return commands.map((definition) =>
    !definition.flags?.permission
      ? definition
      : {
          ...definition,
          flags: {
            ...definition.flags,
            permission: flag.enum(["use", "manage"], {
              required: true,
              description: "use: open the app; manage: use it and manage access",
            }),
          },
          run: (input: Parameters<typeof definition.run>[0]) =>
            definition.run({ ...input, flags: { ...input.flags, permission: input.flags.permission === "use" ? "read" : "admin" } }),
        },
  );
};
