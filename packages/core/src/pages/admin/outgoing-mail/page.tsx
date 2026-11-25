import type { AdminMailProfile } from "@k2b/cloud/contracts";
import { type AuthContext, getDateConfig, getLocale, getTimeZone } from "@k2b/cloud/server";
import { outgoingMailLog } from "@k2b/cloud/services/outgoing-mail/admin";
import { readMailRetentionSettings } from "@k2b/cloud/services/outgoing-mail/retention";
import { outgoingMailStore } from "@k2b/cloud/services/outgoing-mail/store";
import { formatDateTime } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { buildEntries } from "../settings/entries";
import AppsScreen from "./AppsScreen.island";
import { legacyOutgoingMailHref, outgoingMailNav, outgoingMailText } from "./area";
import { SEND_LOG_PAGE_SIZE } from "./LogScreen";
import LogScreen from "./LogScreen.island";
import { logFilter, logQuery, parseLogAddress } from "./log-query";
import type { ProfileRow } from "./ProfilesScreen";
import ProfilesScreen from "./ProfilesScreen.island";
import { bounceReason } from "./shared";
import TemplatesScreen from "./TemplatesScreen.island";

/** Sender profiles, the start of Outgoing mail; `?profile=<key>` or `?profile=new` opens one. */
export const profilesPage = ssr<AuthContext>(async (c) => {
  // Send log filters on the area's start come from before the sections.
  const legacy = legacyOutgoingMailHref(c.req.url);
  if (legacy) return c.redirect(legacy, 302);
  const locale = getLocale(c);
  const t = outgoingMailText(locale);
  const dates = { ...getDateConfig(c), locale };
  const profiles = await outgoingMailStore.list();
  const bounce = (profile: AdminMailProfile) => {
    const bounces = profile.bounces;
    if (!bounces) return t.bouncesOff;
    if (bounces.error) return `${t.bouncesFailed}: ${bounceReason(bounces.error, t)}`;
    return bounces.checkedAt ? `${t.bouncesChecked} ${formatDateTime(bounces.checkedAt, dates)}` : t.bouncesPending;
  };
  const rows: ProfileRow[] = profiles.map((profile) => ({
    ...profile,
    bounceText: bounce(profile),
    bounceFailed: !!profile.bounces?.error,
  }));
  const requested = c.req.query("profile") ?? null;
  const open = requested === "new" || rows.some((row) => row.key === requested) ? requested : null;
  return () => (
    <AdminLayout c={c} ui="v2" title={t.title}>
      <ProfilesScreen nav={outgoingMailNav(c, locale, "profiles")} profiles={rows} open={open} />
    </AdminLayout>
  );
});

/** Which app may send with which profile and read whose send log; `?app=<id>` opens one. */
export const appsPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [profiles, apps] = await Promise.all([outgoingMailStore.list(), outgoingMailStore.apps()]);
  const requested = c.req.query("app") ?? null;
  const open = apps.items.some((app) => app.appId === requested) ? requested : null;
  return () => (
    <AdminLayout c={c} ui="v2" title={outgoingMailText(locale).apps}>
      <AppsScreen nav={outgoingMailNav(c, locale, "apps")} profiles={profiles} apps={apps.items} open={open} />
    </AdminLayout>
  );
});

/** The send log: its filters and the open message (`?message=`) are in the address. */
export const logPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const apps = (await outgoingMailStore.apps()).items.map((app) => ({ appId: app.appId, name: app.name }));
  const query = logQuery(locale, apps);
  const address = parseLogAddress(query, new URL(c.req.url).searchParams);
  if (address.redirect) return c.redirect(address.redirect, 302);
  const [page, retention, message] = await Promise.all([
    outgoingMailLog.list(logFilter(address.state), { perPage: SEND_LOG_PAGE_SIZE }),
    readMailRetentionSettings(),
    address.message ? outgoingMailLog.get(address.message).catch(() => null) : Promise.resolve(null),
  ]);
  return () => (
    <AdminLayout c={c} ui="v2" title={outgoingMailText(locale).sendLog}>
      <LogScreen
        nav={outgoingMailNav(c, locale, "log")}
        apps={apps}
        state={address.state}
        page={page}
        retention={retention}
        message={message}
        timeZone={getTimeZone(c)}
      />
    </AdminLayout>
  );
});

/** The transactional email templates, from the former settings page. */
export const templatesPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const entries = (await buildEntries("mail", locale)).filter((entry) => entry.kind === "template");
  const t = outgoingMailText(locale);
  return () => (
    <AdminLayout c={c} ui="v2" title={t.templates}>
      <TemplatesScreen
        nav={outgoingMailNav(c, locale, "templates")}
        sections={[{ title: t.templates, keys: entries.map((entry) => entry.key) }]}
        entries={entries}
      />
    </AdminLayout>
  );
});
