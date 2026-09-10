import { z } from "zod";
import { arg, cliText, command, confirmFlag, flag, printStructured } from "../index";
import { apiGet, apiJson } from "./shared";

const root = "/api/admin/identity/workloads";
const path = (appId: string) => `${root}/${encodeURIComponent(appId)}/credentials`;
const metadata = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  tokenPrefix: z.string(),
  expiresAt: z.string().nullable(),
});

export const appCredentialCommands = [
  command("app-credentials apps", {
    summary: "List registered applications for workload credentials",
    async run({ ctx }) {
      const apps = z.array(z.object({ id: z.string(), name: z.string() })).parse(await apiGet(ctx, root));
      if (!printStructured(ctx, apps))
        ctx.table(apps, [
          { key: "id", label: "App" },
          { key: "name", label: "Name" },
        ]);
    },
  }),
  command("app-credentials list", {
    summary: "List one app's credential metadata without secrets",
    args: { app: arg.required({ valueLabel: "app" }) },
    flags: { page: flag.int({ min: 1, default: 1 }), perPage: flag.int({ min: 1, max: 500, default: 20 }) },
    async run({ ctx, args, flags }) {
      const listing = z
        .object({ items: z.array(metadata), page: z.number(), perPage: z.number(), total: z.number(), hasNext: z.boolean() })
        .parse(await apiGet(ctx, `${path(args.app)}?page=${flags.page}&perPage=${flags.perPage}`));
      if (!printStructured(ctx, listing))
        ctx.table(listing.items, [
          { key: "id", label: "ID" },
          { key: "name", label: "Name" },
          { key: "status", label: "Status" },
          { key: "expiresAt", label: "Expires" },
        ]);
    },
  }),
  command("app-credentials create", {
    summary: "Create an app credential; returns the token once (store stdout securely)",
    args: { app: arg.required({ valueLabel: "app" }) },
    flags: {
      name: flag.string({ required: true }),
      expiresAt: flag.string({ description: "Optional future ISO 8601 expiry" }),
      yes: confirmFlag("Create this app credential"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes)
        throw new Error(cliText(ctx, { en: "Creating an app credential requires --yes.", de: "App-Zugang erstellen erfordert --yes." }));
      const result = z
        .object({ credential: metadata, token: z.string() })
        .parse(
          await apiJson(ctx, "POST", path(args.app), {
            name: flags.name,
            scopes: ["identity:invoke"],
            ...(flags.expiresAt ? { expiresAt: flags.expiresAt } : {}),
          }),
        );
      if (!printStructured(ctx, result)) ctx.print(result.token);
    },
  }),
  command("app-credentials revoke", {
    summary: "Revoke one exact app credential; its background calls will stop",
    args: { app: arg.required({ valueLabel: "app" }), credential: arg.required({ valueLabel: "credential" }) },
    flags: { yes: confirmFlag("Revoke this app credential") },
    async run({ ctx, args, flags }) {
      if (!flags.yes)
        throw new Error(cliText(ctx, { en: "Revoking an app credential requires --yes.", de: "App-Zugang widerrufen erfordert --yes." }));
      const credentialId = z.uuid().parse(args.credential);
      const result = await apiJson(ctx, "DELETE", `${path(args.app)}/${credentialId}`);
      if (!printStructured(ctx, result)) ctx.print(cliText(ctx, { en: "Credential revoked.", de: "Zugang widerrufen." }));
    },
  }),
];
