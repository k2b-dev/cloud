/** Named administration operations that use the same owning APIs as the UI. */
import { z } from "zod";
import { arg, command, confirmFlag, flag, printStructured } from "../index";
import { apiGet } from "./shared";

export type AdminOperation = {
  command: string;
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: boolean;
  resultFields?: readonly string[];
  query?: Record<string, string>;
};
export const ADMIN_OPERATIONS: readonly AdminOperation[] = [
  { command: "settings apply", method: "PUT", path: "/api/admin/core/settings", body: true },
  { command: "settings reset", method: "DELETE", path: "/api/admin/core/settings/:key" },
  { command: "settings legacy list", method: "GET", path: "/api/admin/core/settings/legacy" },
  { command: "settings legacy delete", method: "DELETE", path: "/api/admin/core/settings/legacy" },
  { command: "settings test pdf", method: "POST", path: "/api/admin/core/settings/test-pdf" },
  { command: "settings test storage", method: "POST", path: "/api/admin/core/settings/test-storage" },
  { command: "settings test freeipa", method: "POST", path: "/api/admin/core/settings/test-freeipa" },
  { command: "ai enrichment run", method: "POST", path: "/api/admin/core/settings/run-ai-enrichment" },
  { command: "apps status", method: "GET", path: "/api/admin/apps/:app/status" },
  { command: "lifecycle deleted-accounts", method: "GET", path: "/api/admin/lifecycle/deleted-accounts" },
  { command: "lifecycle reminders", method: "GET", path: "/api/admin/lifecycle/reminders" },
  { command: "lifecycle health", method: "GET", path: "/api/admin/lifecycle/health" },
  { command: "lifecycle run", method: "POST", path: "/api/admin/lifecycle/jobs", body: true, resultFields: ["jobId"] },
  { command: "rail show", method: "GET", path: "/api/admin/core/rail" },
  { command: "rail set", method: "PUT", path: "/api/admin/core/rail", body: true },
  { command: "rail cache-clear", method: "DELETE", path: "/api/admin/core/rail/cache" },
  { command: "ai projects list", method: "GET", path: "/api/admin/core/ai-projects" },
  { command: "ai projects access list", method: "GET", path: "/api/admin/core/ai-projects/:project/access" },
  {
    command: "ai projects access grant",
    method: "POST",
    path: "/api/admin/core/ai-projects/:project/access",
    body: true,
    resultFields: ["accessId"],
  },
  { command: "ai projects access set", method: "PATCH", path: "/api/admin/core/ai-projects/:project/access/:entry", body: true },
  { command: "ai projects access revoke", method: "DELETE", path: "/api/admin/core/ai-projects/:project/access/:entry" },
  { command: "ai projects delete", method: "DELETE", path: "/api/admin/core/ai-projects/:project" },
  { command: "geo status", method: "GET", path: "/api/admin/core/geo" },
  { command: "geo usage", method: "GET", path: "/api/admin/core/geo/usage" },
  { command: "geo key set", method: "PUT", path: "/api/admin/core/geo/key", body: true },
  { command: "geo key remove", method: "DELETE", path: "/api/admin/core/geo/key" },
  { command: "geo budget set", method: "PUT", path: "/api/admin/core/geo/budget", body: true },
  { command: "identity keys status", method: "GET", path: "/api/admin/identity/keys" },
  { command: "identity mandates list", method: "GET", path: "/api/admin/identity/mandates" },
  { command: "directory-shares list", method: "GET", path: "/api/admin/identity/directory-shares/:recipient" },
  {
    command: "directory-shares grant",
    method: "POST",
    path: "/api/admin/identity/directory-shares/:recipient",
    body: true,
    resultFields: ["id"],
  },
  { command: "directory-shares revoke", method: "DELETE", path: "/api/admin/identity/directory-shares/:recipient/:entry" },
  { command: "capabilities summary", method: "GET", path: "/api/gateway/capabilities" },
  { command: "capabilities executions list", method: "GET", path: "/api/gateway/capabilities/executions" },
  { command: "capabilities executions show", method: "GET", path: "/api/gateway/capabilities/executions/:request" },
  { command: "telemetry browser", method: "GET", path: "/api/gateway/telemetry/browser" },
  { command: "logs retention show", method: "GET", path: "/api/logging/settings/retention" },
  { command: "logs retention set", method: "PUT", path: "/api/logging/settings/retention", body: true },
  { command: "weather config set", method: "PUT", path: "/api/weather/admin/settings", body: true },
  { command: "weather config reset", method: "DELETE", path: "/api/weather/admin/settings/:key" },
  { command: "files provisioning", method: "GET", path: "/api/filesv2/admin/provisioning" },
  { command: "files machines list", method: "GET", path: "/api/filesv2/admin/machine-storage" },
  { command: "files machines create", method: "POST", path: "/api/filesv2/admin/machine-storage", body: true, resultFields: ["id"] },
  { command: "files machines grants list", method: "GET", path: "/api/filesv2/admin/machine-storage/:storage/grants" },
  {
    command: "files machines grants grant",
    method: "POST",
    path: "/api/filesv2/admin/machine-storage/:storage/grants",
    body: true,
    resultFields: ["id"],
  },
  { command: "files machines grants revoke", method: "DELETE", path: "/api/filesv2/admin/machine-storage/:storage/grants/:entry" },
  {
    command: "studio machines access list",
    method: "GET",
    path: "/api/assistant/artifacts/machine/:resource/access",
    query: { administrative: "true" },
  },
  {
    command: "studio machines access set",
    method: "PUT",
    path: "/api/assistant/artifacts/machine/:resource/access/:entry",
    body: true,
    query: { administrative: "true" },
  },
  {
    command: "studio machines secrets list",
    method: "GET",
    path: "/api/assistant/artifacts/machine/:resource/secrets",
    query: { administrative: "true" },
  },
  {
    command: "studio machines secrets set",
    method: "PUT",
    path: "/api/assistant/artifacts/machine/:resource/secrets",
    body: true,
    query: { administrative: "true" },
  },
  {
    command: "studio machines secrets delete",
    method: "DELETE",
    path: "/api/assistant/artifacts/machine/:resource/secrets/:name",
    body: true,
    query: { administrative: "true" },
  },
  { command: "chat status", method: "GET", path: "/api/chat/admin/health" },
  { command: "contacts list", method: "GET", path: "/api/contacts/admin/books" },
  { command: "contacts access list", method: "GET", path: "/api/contacts/admin/books/:book/access" },
  { command: "contacts access grant", method: "POST", path: "/api/contacts/admin/books/:book/access", body: true, resultFields: ["id"] },
  { command: "contacts access set", method: "PATCH", path: "/api/contacts/admin/books/:book/access/:entry", body: true },
  { command: "contacts access revoke", method: "DELETE", path: "/api/contacts/admin/books/:book/access/:entry" },
  { command: "spaces list", method: "GET", path: "/api/spaces/admin" },
  { command: "spaces access list", method: "GET", path: "/api/spaces/admin/:space/access" },
  { command: "spaces access grant", method: "POST", path: "/api/spaces/admin/:space/access", body: true, resultFields: ["id"] },
  { command: "spaces access set", method: "PATCH", path: "/api/spaces/admin/:space/access/:entry", body: true },
  { command: "spaces access revoke", method: "DELETE", path: "/api/spaces/admin/:space/access/:entry" },
  { command: "spaces delete", method: "DELETE", path: "/api/spaces/admin/:space" },
  { command: "proxy-auth list", method: "GET", path: "/api/proxy-auth" },
  { command: "proxy-auth show", method: "GET", path: "/api/proxy-auth/:client" },
  { command: "proxy-auth add", method: "POST", path: "/api/proxy-auth", body: true, resultFields: ["id"] },
  { command: "proxy-auth set", method: "PUT", path: "/api/proxy-auth/:client", body: true },
  { command: "proxy-auth delete", method: "DELETE", path: "/api/proxy-auth/:client" },
];

export const administrationCommands = ADMIN_OPERATIONS.map((operation) => {
  const args: Record<string, ReturnType<typeof arg.required>> = {};
  for (const match of operation.path.matchAll(/:([a-zA-Z]+)/g)) args[match[1]!] = arg.required();
  return command(operation.command, {
    summary: `${operation.method === "GET" ? "Read" : "Configure"} ${operation.command.replaceAll("-", " ")}`,
    args,
    flags: {
      ...(operation.method === "GET"
        ? { query: flag.string({ description: "URL query string for this API's documented filters" }) }
        : { yes: confirmFlag("Confirm administrator change") }),
      ...(operation.body
        ? {
            from: flag.string({
              required: true,
              description: "JSON body from a file or - for stdin; credentials never belong in arguments",
            }),
          }
        : {}),
    },
    async run({ ctx, args, flags }) {
      const params = new URLSearchParams("query" in flags ? flags.query : undefined);
      for (const [key, value] of Object.entries(operation.query ?? {})) params.set(key, value);
      const query = params.size ? `?${params}` : "";
      const path = operation.path.replace(/:([a-zA-Z]+)/g, (_match, key: string) => encodeURIComponent(args[key]!)) + query;
      if (operation.method === "GET") {
        const result = await apiGet(ctx, path);
        if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
        return;
      }
      if (!("yes" in flags) || !flags.yes) throw new Error("Administrator changes require --yes.");
      let body: string | undefined;
      if (operation.body) {
        const raw = flags.from === "-" ? await Bun.stdin.text() : await Bun.file(flags.from!).text();
        try {
          body = JSON.stringify(JSON.parse(raw));
        } catch {
          throw new Error("Input must be valid JSON.");
        }
      }
      const response = await ctx.fetch(path, {
        method: operation.method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
      });
      if (!response.ok) await ctx.readJson(response);
      // Return only explicitly selected identifiers; owner responses can include credentials or submitted settings.
      const result: Record<string, string | boolean> = { saved: true };
      if (operation.resultFields) {
        const data = z.record(z.string(), z.unknown()).parse(await ctx.readJson(response));
        for (const key of operation.resultFields) {
          const value = key === "accessId" ? z.object({ id: z.string() }).safeParse(data.access).data?.id : data[key];
          if (typeof value === "string") result[key] = value;
        }
      }
      if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result));
    },
  });
});
