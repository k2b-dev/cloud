import { z } from "zod";
import { arg, type CloudCliContext, cliText, command, confirmFlag, flag, localizeCloudCliText, printStructured } from "../index";
import { apiGet, apiJson } from "./shared";

const step = z.object({ ok: z.boolean(), detail: z.string() });
const status = z.object({ checkedAt: z.string(), dns: step, certificate: step.nullable(), reachable: step.nullable() });
const domain = z.object({
  host: z.string(),
  redirectTo: z.string().nullable(),
  createdAt: z.string(),
  active: z.boolean(),
  status: status.nullable(),
});
const path = (appId: string, host?: string) =>
  `/api/admin/apps/${encodeURIComponent(appId)}/domains${host === undefined ? "" : `/${encodeURIComponent(host)}`}`;
const appArgs = { appId: arg.required({ valueLabel: "appId" }) };
const domainArgs = { ...appArgs, host: arg.required({ valueLabel: "host" }) };
const show = (ctx: CloudCliContext, raw: unknown, domains: z.infer<typeof domain>[]) => {
  if (printStructured(ctx, raw)) return;
  const checked = (result: z.infer<typeof step> | null | undefined) =>
    result == null ? "-" : result.ok ? "ok" : cliText(ctx, { en: "failed", de: "fehlgeschlagen" });
  ctx.table(
    domains.map((item) => ({
      host: item.host,
      redirect: item.redirectTo ?? "-",
      active: item.active,
      dns: checked(item.status?.dns),
      certificate: checked(item.status?.certificate),
      reachable: checked(item.status?.reachable),
    })),
    [
      { key: "host", label: "Host" },
      { key: "redirect", label: cliText(ctx, { en: "Redirect", de: "Weiterleitung" }) },
      { key: "active", label: cliText(ctx, { en: "Active", de: "Aktiv" }) },
      { key: "dns", label: "DNS" },
      { key: "certificate", label: cliText(ctx, { en: "Certificate", de: "Zertifikat" }) },
      { key: "reachable", label: cliText(ctx, { en: "Reachable", de: "Erreichbar" }) },
    ],
  );
};

export const appDomainCommands = (locale?: string) => {
  const t = (en: string, de: string) => localizeCloudCliText(locale, { en, de });
  return [
    command("apps domains ls", {
      summary: t(
        "List app domains, redirects and DNS/TLS/gateway status",
        "App-Domains, Weiterleitungen und DNS/TLS/Gateway-Status auflisten",
      ),
      args: appArgs,
      async run({ ctx, args }) {
        const result = z.object({ domains: z.array(domain) }).parse(await apiGet(ctx, path(args.appId)));
        show(ctx, result, result.domains);
      },
    }),
    command("apps domains add", {
      summary: t(
        "Assign a domain to a registered app and start its first check",
        "Eine Domain einer bekannten App zuordnen und erstmals prüfen",
      ),
      args: domainArgs,
      flags: {
        redirectTo: flag.string({
          description: t("Another domain of this app without a redirect", "Eine andere Domain dieser App ohne Weiterleitung"),
        }),
      },
      async run({ ctx, args, flags }) {
        const result = domain.parse(
          await apiJson(ctx, "POST", path(args.appId), { host: args.host, ...(flags.redirectTo ? { redirectTo: flags.redirectTo } : {}) }),
        );
        show(ctx, result, [result]);
      },
    }),
    command("apps domains set", {
      summary: t("Set or clear an app domain redirect", "Eine Domain-Weiterleitung setzen oder entfernen"),
      args: domainArgs,
      flags: {
        redirectTo: flag.string({
          description: t("Another domain of this app without a redirect", "Eine andere Domain dieser App ohne Weiterleitung"),
        }),
        noRedirect: flag.boolean({ description: t("Clear the redirect", "Die Weiterleitung entfernen") }),
      },
      async run({ ctx, args, flags }) {
        if (Boolean(flags.redirectTo) === flags.noRedirect)
          throw new Error(
            cliText(ctx, {
              en: "Use exactly one of --redirect-to or --no-redirect.",
              de: "Nutze genau eine Option: --redirect-to oder --no-redirect.",
            }),
          );
        const result = domain.parse(
          await apiJson(ctx, "PATCH", path(args.appId, args.host), { redirectTo: flags.noRedirect ? null : flags.redirectTo }),
        );
        show(ctx, result, [result]);
      },
    }),
    command("apps domains rm", {
      summary: t("Remove an unreferenced app domain assignment", "Eine App-Domain ohne eingehende Weiterleitungen entfernen"),
      args: domainArgs,
      flags: { yes: confirmFlag(t("Remove this domain assignment", "Diese Domain-Zuordnung entfernen")) },
      async run({ ctx, args, flags }) {
        if (!flags.yes)
          throw new Error(cliText(ctx, { en: "Removing a domain requires --yes.", de: "Das Entfernen einer Domain erfordert --yes." }));
        const result = await apiJson(ctx, "DELETE", path(args.appId, args.host));
        if (!printStructured(ctx, result)) ctx.print(cliText(ctx, { en: "Domain removed.", de: "Domain entfernt." }));
      },
    }),
    command("apps domains check", {
      summary: t(
        "Check DNS, certificate and gateway reachability, at most once per 60 seconds",
        "DNS, Zertifikat und Gateway-Erreichbarkeit höchstens einmal pro 60 Sekunden prüfen",
      ),
      args: domainArgs,
      async run({ ctx, args }) {
        const result = z.object({ status: status.nullable() }).parse(await apiJson(ctx, "POST", `${path(args.appId, args.host)}/check`));
        if (printStructured(ctx, result)) return;
        if (!result.status) {
          ctx.print(
            cliText(ctx, {
              en: "The first check is running. List the domains again shortly.",
              de: "Die erste Prüfung läuft. Liste die Domains gleich erneut auf.",
            }),
          );
          return;
        }
        ctx.table(
          (["dns", "certificate", "reachable"] as const).map((key) => {
            const value = result.status![key];
            return { step: key, ok: value?.ok ?? "-", detail: value?.detail ?? "-" };
          }),
          [
            { key: "step", label: cliText(ctx, { en: "Step", de: "Schritt" }) },
            { key: "ok", label: "OK" },
            { key: "detail", label: "Detail" },
          ],
        );
      },
    }),
  ];
};
