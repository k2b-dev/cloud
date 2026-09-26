/**
 * `cld admin agents` — standalone service accounts of kind `agent` with an
 * OAuth client. `create` provisions the account and the client under the
 * administrator's authority and writes the client credentials into a local
 * `cld` profile through the host; the secret is never printed.
 */
import { z } from "zod";
import { arg, cliText, command, confirmFlag, flag, printStructured } from "../index";
import { apiGet, apiJson, queryString } from "./shared";

const accountsRoot = "/api/admin/identity/service-accounts";
const clientsRoot = "/api/oauth/admin/clients";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The scopes a `cld login` device session receives; an agent may do what a signed-in person's `cld` may do. */
export const AGENT_CLIENT_SCOPES = ["openid", "profile", "email", "offline_access", "read", "write"] as const;

const account = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  status: z.enum(["active", "disabled"]),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});
type Account = z.infer<typeof account>;
const accountPage = z.object({ items: z.array(account), page: z.number(), perPage: z.number(), total: z.number(), hasNext: z.boolean() });
const client = z.object({ id: z.string(), clientId: z.string(), name: z.string(), scopes: z.array(z.string()) });
const clientPage = z.object({ clients: z.array(client) });
const createdClient = client.extend({ clientSecret: z.string().min(1) });
const rotatedSecret = z.object({ clientSecret: z.string().min(1) });

type Ctx = Parameters<Parameters<typeof command>[1]["run"]>[0]["ctx"];

const requireProfiles = (ctx: Ctx) => {
  if (!ctx.profiles) {
    throw new Error(
      cliText(ctx, {
        en: "This cld cannot store agent profiles. Update cld and retry.",
        de: "Dieses cld kann keine Agent-Profile speichern. Aktualisiere cld und versuche es erneut.",
      }),
    );
  }
  return ctx.profiles;
};

const requireYes = (ctx: Ctx, yes: boolean | undefined, en: string, de: string) => {
  if (!yes) throw new Error(cliText(ctx, { en, de }));
};

/** Resolve an agent by ID or exact name; ambiguity is an error, nothing is guessed. */
const resolveAgent = async (ctx: Ctx, reference: string): Promise<Account> => {
  if (UUID_PATTERN.test(reference)) {
    const found = account.parse(await apiGet(ctx, `${accountsRoot}/${encodeURIComponent(reference)}`));
    if (found.kind !== "agent") throw new Error(`Service account ${reference} is not an agent (kind ${found.kind}).`);
    return found;
  }
  const page = accountPage.parse(await apiGet(ctx, `${accountsRoot}${queryString({ kind: "agent", search: reference, perPage: 50 })}`));
  const matches = page.items.filter((item) => item.name.toLowerCase() === reference.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No agent named "${reference}". Run \`cld admin agents ls\`.`);
  throw new Error(`Several agents match "${reference}": ${matches.map((item) => `${item.name} (${item.id})`).join(", ")}.`);
};

const disableAccount = (ctx: Ctx, id: string) => apiJson(ctx, "PATCH", `${accountsRoot}/${encodeURIComponent(id)}`, { status: "disabled" });

const requireProfileName = (flags: { profile?: string }): string => {
  if (!flags.profile) throw new Error("Missing required flag --profile.");
  return flags.profile;
};

const fd0Target = (flags: { fd0?: boolean; fd0Name?: string; fd0Scope?: string }, profile: string) =>
  flags.fd0 || flags.fd0Name
    ? { name: flags.fd0Name ?? `cloud-${profile}-oauth-client-secret`, ...(flags.fd0Scope ? { scope: flags.fd0Scope } : {}) }
    : undefined;

const profileFlags = {
  profile: flag.string({ required: true, description: "Local cld profile that receives the client credentials" }),
  server: flag.string({ description: "Cloud origin for that profile (default: the current server)" }),
  fd0: flag.boolean({ description: "Keep the client secret in fd0 instead of the config file" }),
  fd0Name: flag.string({ name: "fd0-name", description: "fd0 secret name (default: cloud-<profile>-oauth-client-secret)" }),
  fd0Scope: flag.string({ name: "fd0-scope", description: "fd0 scope for the secret" }),
};

export const agentCommands = [
  command("agents create", {
    summary: "Create an agent account with an OAuth client and write its credentials into a local cld profile",
    args: { name: arg.required({ valueLabel: "name" }) },
    flags: { ...profileFlags, yes: confirmFlag("Create this agent and its OAuth client") },
    async run({ ctx, args, flags }) {
      requireYes(ctx, flags.yes, "Creating an agent requires --yes.", "Agent erstellen erfordert --yes.");
      const profileName = requireProfileName(flags);
      const profiles = requireProfiles(ctx);
      const server = flags.server ?? ctx.options.server;
      const created = account.parse(await apiJson(ctx, "POST", accountsRoot, { name: args.name, kind: "agent" }));

      let oauthClient: z.infer<typeof createdClient>;
      try {
        oauthClient = createdClient.parse(
          await apiJson(ctx, "POST", clientsRoot, {
            name: `Agent: ${args.name}`,
            description: `Client credentials of the agent "${args.name}" (cld admin agents).`,
            redirectUris: [],
            scopes: [...AGENT_CLIENT_SCOPES],
            audiences: ["cloud"],
            serviceAccountId: created.id,
            allowedProfiles: [],
            accessMode: "profiles",
            allowedUserIds: [],
            allowedGroupIds: [],
            isPublic: false,
          }),
        );
      } catch (error) {
        await disableAccount(ctx, created.id).catch(() => undefined);
        throw new Error(
          `Created the agent account ${created.id} but not its OAuth client; the account was disabled. ${(error as Error).message}`,
        );
      }

      try {
        await profiles.saveClientCredentials({
          name: profileName,
          server,
          clientId: oauthClient.clientId,
          clientSecret: oauthClient.clientSecret,
          scope: oauthClient.scopes.join(" "),
          fd0: fd0Target(flags, profileName),
        });
      } catch (error) {
        await disableAccount(ctx, created.id).catch(() => undefined);
        throw new Error(
          `Could not save profile "${profileName}"; the agent account ${created.id} was disabled. ${(error as Error).message}`,
        );
      }

      const summary = {
        account: created,
        client: { id: oauthClient.id, clientId: oauthClient.clientId, scopes: oauthClient.scopes },
        profile: { name: profileName, server, secretStorage: fd0Target(flags, profileName) ? "fd0" : "config" },
      };
      if (!printStructured(ctx, summary)) {
        ctx.print(`Created agent "${created.name}" (${created.id}) with OAuth client ${oauthClient.clientId}.`);
        ctx.print(`Profile "${profileName}" holds its client credentials. The agent has no access yet; grant it like a user.`);
        ctx.print(`Try: cld --profile ${profileName} account whoami`);
      }
    },
  }),
  command("agents ls", {
    summary: "List agent accounts",
    flags: {
      status: flag.enum(["active", "disabled"] as const),
      search: flag.string({ aliases: ["q"] }),
      page: flag.int({ min: 1, default: 1 }),
      perPage: flag.int({ min: 1, max: 500, default: 100 }),
    },
    async run({ ctx, flags }) {
      const page = accountPage.parse(
        await apiGet(
          ctx,
          `${accountsRoot}${queryString({ kind: "agent", status: flags.status, search: flags.search, page: flags.page, perPage: flags.perPage })}`,
        ),
      );
      if (!printStructured(ctx, page))
        ctx.table(page.items, [
          { key: "status", label: "Status" },
          { key: "name", label: "Name" },
          { key: "id", label: "ID" },
          { key: "createdAt", label: "Created" },
        ]);
    },
  }),
  command("agents revoke", {
    summary: "Disable an agent; every token, secret, and API key of it stops working at once",
    args: { agent: arg.required({ valueLabel: "agent-id-or-name" }) },
    flags: { yes: confirmFlag("Disable this agent") },
    async run({ ctx, args, flags }) {
      requireYes(ctx, flags.yes, "Revoking an agent requires --yes.", "Agent widerrufen erfordert --yes.");
      const agent = await resolveAgent(ctx, args.agent);
      const updated = account.parse(await disableAccount(ctx, agent.id));
      if (!printStructured(ctx, updated)) ctx.print(`Disabled agent "${updated.name}" (${updated.id}).`);
    },
  }),
  command("agents rotate-secret", {
    summary: "Regenerate an agent's OAuth client secret and update the local cld profile",
    args: { agent: arg.required({ valueLabel: "agent-id-or-name" }) },
    flags: { ...profileFlags, yes: confirmFlag("Rotate this agent's client secret") },
    async run({ ctx, args, flags }) {
      requireYes(ctx, flags.yes, "Rotating a secret requires --yes.", "Secret rotieren erfordert --yes.");
      const profileName = requireProfileName(flags);
      const profiles = requireProfiles(ctx);
      const agent = await resolveAgent(ctx, args.agent);
      const { clients } = clientPage.parse(await apiGet(ctx, `${clientsRoot}${queryString({ serviceAccountId: agent.id, per_page: 50 })}`));
      if (clients.length !== 1) {
        throw new Error(
          clients.length === 0
            ? `Agent "${agent.name}" has no OAuth client.`
            : `Agent "${agent.name}" has several OAuth clients: ${clients.map((item) => item.clientId).join(", ")}. Rotate one with cld oauth clients regenerate-secret.`,
        );
      }
      const oauthClient = clients[0]!;
      const rotated = rotatedSecret.parse(
        await apiJson(ctx, "POST", `${clientsRoot}/${encodeURIComponent(oauthClient.id)}/regenerate-secret`),
      );
      await profiles.saveClientCredentials({
        name: profileName,
        server: flags.server ?? ctx.options.server,
        clientId: oauthClient.clientId,
        clientSecret: rotated.clientSecret,
        scope: oauthClient.scopes.join(" "),
        fd0: fd0Target(flags, profileName),
      });
      const summary = { account: agent, client: { id: oauthClient.id, clientId: oauthClient.clientId }, profile: profileName };
      if (!printStructured(ctx, summary)) {
        ctx.print(`Rotated the client secret of agent "${agent.name}"; profile "${profileName}" holds the new secret.`);
      }
    },
  }),
];
