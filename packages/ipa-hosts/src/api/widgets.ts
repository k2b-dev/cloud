import { i18n } from "@k2b/stdlib";
import type { WidgetBlock, WidgetResponse } from "@valentinkolb/cloud/contracts";
import { hasRole } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale } from "@valentinkolb/cloud/server";
import { type Context, Hono } from "hono";
import { ipaHostsService } from "../service";

const widgetMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      emptyMirror: "Empty mirror",
      emptyMirrorHint: "Run a sync to import hosts and hostgroups from FreeIPA",
      allAssigned: ({ count, value }: { count: number; value: string }) => `${value} host${count === 1 ? "" : "s"} · all assigned`,
      ungroupedHosts: ({ count, value }: { count: number; value: string }) => `${value} ungrouped host${count === 1 ? "" : "s"}`,
      mirroredHostgroups: ({ count, value }: { count: number; value: string }) =>
        `${value} hostgroup${count === 1 ? "" : "s"} mirrored from FreeIPA`,
      mirroredHosts: ({ count }: { count: string }) => `Out of ${count} mirrored hosts`,
      groups: "groups",
      inGroups: "in groups",
      ungrouped: "ungrouped",
      title: "IPA hosts",
    },
    de: {
      emptyMirror: "Leerer Spiegel",
      emptyMirrorHint: "Starte eine Synchronisierung, um Hosts und Hostgruppen aus FreeIPA zu importieren",
      allAssigned: ({ count, value }) => `${value} Host${count === 1 ? "" : "s"} · alle zugeordnet`,
      ungroupedHosts: ({ count, value }) => `${value} nicht gruppierte${count === 1 ? "r Host" : " Hosts"}`,
      mirroredHostgroups: ({ count, value }) => `${value} Hostgruppe${count === 1 ? "" : "n"} aus FreeIPA gespiegelt`,
      mirroredHosts: ({ count }) => `Von ${count} gespiegelten Hosts`,
      groups: "Gruppen",
      inGroups: "in Gruppen",
      ungrouped: "nicht gruppiert",
      title: "IPA-Hosts",
    },
  },
});

type IpaHostsWidgetStats = Awaited<ReturnType<typeof ipaHostsService.stats>>;

export const ipaHostsWidgetBody = (stats: IpaHostsWidgetStats, requestedLocale: string): WidgetResponse => {
  const { locale, t } = widgetMessages.resolve([requestedLocale]);
  const number = new Intl.NumberFormat(locale);
  const blocks: WidgetBlock[] = [];

  if (stats.hostsTotal === 0 && stats.hostgroupsTotal === 0) {
    blocks.push({ kind: "hero", icon: "ti ti-server-off", tone: "blue", title: t.emptyMirror, subtitle: t.emptyMirrorHint });
  } else {
    const tone: "ok" | "warn" = stats.hostsUngrouped > 0 ? "warn" : "ok";
    blocks.push({
      kind: "status",
      grow: true,
      tone,
      title:
        stats.hostsUngrouped === 0
          ? t.allAssigned({ count: stats.hostsTotal, value: number.format(stats.hostsTotal) })
          : t.ungroupedHosts({ count: stats.hostsUngrouped, value: number.format(stats.hostsUngrouped) }),
      message:
        stats.hostsUngrouped === 0
          ? t.mirroredHostgroups({ count: stats.hostgroupsTotal, value: number.format(stats.hostgroupsTotal) })
          : t.mirroredHosts({ count: number.format(stats.hostsTotal) }),
      icon: "ti ti-server",
    });
    blocks.push({
      kind: "pills",
      pills: [
        { label: t.groups, value: stats.hostgroupsTotal, tone: "blue" },
        { label: t.inGroups, value: stats.hostsInGroups },
        ...(stats.hostsUngrouped > 0 ? [{ label: t.ungrouped, value: stats.hostsUngrouped, tone: "amber" as const }] : []),
      ],
    });
  }

  return { title: t.title, icon: "ti ti-server", href: "/admin/ipa-hosts", blocks };
};

/**
 * IPA hosts sync widget — admin only. Status banner reports whether every
 * mirrored host has at least one hostgroup membership; pills carry the raw
 * counts so the admin can decide whether to dive into /admin/ipa-hosts.
 */
export const ipaSyncWidgetHandler = async (c: Context<AuthContext>) => {
  const actor = c.get("actor") as AuthContext["Variables"]["actor"] | undefined;
  const user = actor?.kind === "user" ? actor.user : actor?.delegatedUser;
  // 403 = admin-only widget.
  if (!user || !hasRole(user, "admin")) return c.body(null, 403);

  const stats = await ipaHostsService.stats();
  return c.json(ipaHostsWidgetBody(stats, getLocale(c)));
};

const app = new Hono<AuthContext>().use(auth.requireRole("*")).get("/sync", ipaSyncWidgetHandler);

export default app;
