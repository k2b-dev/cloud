import { AppDetailsSchema } from "../contracts/app-details";
import { arg, type CloudCliContext, command, defineCliCommands, flag, localizeCloudCliText, printRows, printStructured } from "./index";

type VisibleApp = {
  id: string;
  name: string;
  description: string;
  icon: string;
  href: string;
};

const listApps = async (ctx: CloudCliContext, search: string | undefined) => {
  const query = search ? `?${new URLSearchParams({ search }).toString()}` : "";
  return ctx.readJson<{ items: VisibleApp[] }>(await ctx.fetch(`/api/apps${query}`));
};

const build = (locale?: string) => {
  const t = (en: string, de: string) => localizeCloudCliText(locale, { en, de });
  return defineCliCommands({
    name: "apps",
    summary: t("List Cloud apps and inspect their declarations.", "Cloud-Apps auflisten und ihre Deklarationen prüfen."),
    commands: [
      command("show", {
        summary: t(
          "Inspect one app's access, events and notifications (admin)",
          "Zugriff, Events und Benachrichtigungen einer App prüfen (Admin)",
        ),
        args: { app: arg.required({ description: t("App ID", "App-ID") }) },
        run: async ({ ctx, args }) => {
          const result = AppDetailsSchema.parse(
            await ctx.readJson(await ctx.fetch(`/api/app-events/apps/${encodeURIComponent(args.app)}`)),
          );
          if (printStructured(ctx, result)) return;
          const { app, access } = result;
          const printOmitted = (shown: number, total: number) => {
            if (total > shown) ctx.print(t(`… ${total - shown} more omitted`, `… ${total - shown} weitere ausgelassen`));
          };
          ctx.print(
            `${t("App", "Anwendung")}: ${app.name} (${app.id}) · ${app.online ? t("online", "erreichbar") : t("offline", "nicht erreichbar")}`,
          );
          if (app.description) ctx.print(app.description);
          ctx.print(`\n${t("Access", "Zugriff")}: ${access.kind ?? t("unknown (offline)", "unbekannt (offline)")}`);
          if (access.roles.length) ctx.print(`${t("Roles", "Rollen")}: ${access.roles.join(", ")}`);
          if (access.grantCount !== null) ctx.print(`${t("Grants", "Freigaben")}: ${access.grantCount}`);
          ctx.print(`${t("Platform permissions", "Plattformrechte")}: ${access.platformPermissions.join(", ") || "—"}`);
          ctx.print(`\n${t("Sends", "Sendet")} (${result.sends.length}/${result.totals.sends})`);
          for (const event of result.sends) {
            ctx.print(`${event.type} v${event.version} · ${event.title} · ${event.subscriberCount} ${t("subscribers", "Abonnenten")}`);
            ctx.print(
              `  ${event.subject}${event.place ? ` @ ${event.place}` : ""} · ${t("automation", "Automatisierung")}=${event.automation ? t("yes", "ja") : t("no", "nein")}`,
            );
          }
          printOmitted(result.sends.length, result.totals.sends);
          ctx.print(`\n${t("Hears", "Hört")} (${result.hears.length}/${result.totals.hears})`);
          for (const subscription of result.hears) {
            ctx.print(
              `${subscription.eventType} v${subscription.version} · ${subscription.state}${subscription.isNew ? ` · ${t("new", "neu")}` : ""} · ${subscription.counts.failed} ${t("failed", "fehlgeschlagen")}`,
            );
            ctx.print(`  ${subscription.subscriptionId}${subscription.reason ? ` · ${subscription.reason}` : ""}`);
            for (const failure of subscription.failedDeliveries)
              ctx.print(
                `  ${failure.id} · ${failure.code ?? t("failed", "fehlgeschlagen")} · ${failure.attempts} ${t("attempts", "Versuche")}`,
              );
          }
          printOmitted(result.hears.length, result.totals.hears);
          ctx.print(`\n${t("Notifications", "Benachrichtigungen")} (${result.notifications.length}/${result.totals.notifications})`);
          for (const notification of result.notifications) {
            ctx.print(`${notification.id} · ${notification.label} · ${notification.recipientKind}`);
            ctx.print(
              `  ${t("Required", "Erforderlich")}: ${notification.requiredChannels.join(", ") || "—"}; ${t("recommended", "empfohlen")}: ${notification.recommendedChannels.join(", ") || "—"}; ${t("excluded", "ausgeschlossen")}: ${notification.excludedChannels.join(", ") || "—"}`,
            );
          }
          printOmitted(result.notifications.length, result.totals.notifications);
        },
      }),
      command("list", {
        summary: t("List available Cloud apps", "Verfügbare Cloud-Apps auflisten"),
        flags: {
          search: flag.string({
            aliases: ["q"],
            description: t("Filter by app name, id, or description", "Nach App-Name, ID oder Beschreibung filtern"),
          }),
        },
        run: async ({ ctx, flags }) => {
          const result = await listApps(ctx, flags.search);
          printRows(ctx, result, result.items, [
            { key: "id", label: "ID" },
            { key: "name", label: "NAME" },
            { key: "description", label: t("DESCRIPTION", "BESCHREIBUNG") },
            { key: "href", label: "URL" },
          ]);
        },
      }),
    ],
  });
};

const appsCliModule = build();
export default {
  ...appsCliModule,
  help: (locale?: string) => build(locale).help?.(locale) ?? "",
  run: (ctx: CloudCliContext) => build(ctx.options.locale).run(ctx),
};
