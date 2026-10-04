import { LocaleProvider, MobileShell, TabBar, type TabBarItem } from "@k2b/ui";
import type { JSX } from "solid-js";
import { PWA_SCOPE } from "../contracts/pwa";
import { getLocale } from "../server/locale";
import { readThemeFromCookieHeader } from "../shared/theme";
import { visiblePwaParts } from "./app-navigation";
import type { LayoutContext } from "./layout-context";
import PwaRuntime from "./PwaRuntime.island";
import { pwaMessages } from "./pwa-messages";
import { getRuntimeContext } from "./runtime";
import TimezoneCookie from "./TimezoneCookie.island";

/** Parts with their own tab; Start lists every part and doubles as "More". */
const TAB_PARTS = 3;

export type PwaLayoutProps = {
  c: LayoutContext;
  /** Header heading and document title. */
  title: string;
  /** Up-navigation inside the part, for example from a detail back to its list. */
  back?: { href: string; label: string };
  /** At most two icon buttons at the header end. */
  actions?: JSX.Element;
  children: JSX.Element;
};

/**
 * The frame of every page in the installable mobile app (preview): the app's document head, a phone shell with a
 * tab bar of Start and the first parts, and the browser runtime (service worker, offline notice, session keepalive).
 * Pages render it below `/pwa/` with `ssr.pwaAccess`.
 */
export default function PwaLayout(props: PwaLayoutProps) {
  const { c } = props;
  const locale = getLocale(c);
  const t = pwaMessages.resolve([locale]).t;
  const user = c.get("user");
  const cloud = c.get("settings")?.app?.name || "Cloud";
  const page = c.get("page");
  page.theme = readThemeFromCookieHeader(c.req.raw.headers.get("Cookie"));
  page.title = props.title;
  page.pwa = { name: cloud };

  const parts = visiblePwaParts(getRuntimeContext(c).apps, user, locale);
  const path = new URL(c.req.raw.url).pathname;
  const tabs = parts.slice(0, TAB_PARTS);
  const currentTab = tabs.find((part) => path === part.pwa.href || path.startsWith(`${part.pwa.href}/`));
  const items: TabBarItem[] = [
    { id: "start", label: t.start, icon: "ti ti-home", href: PWA_SCOPE, current: !currentTab },
    ...tabs.map((part) => ({ id: part.id, label: part.name, icon: part.icon, href: part.pwa.href, current: part === currentTab })),
  ];

  return (
    <LocaleProvider locale={locale}>
      <TimezoneCookie />
      <MobileShell
        header={<MobileShell.Header title={props.title} back={props.back} actions={props.actions} />}
        footer={user && parts.length > 0 ? <TabBar label={t.tabs} items={items} /> : undefined}
      >
        {props.children}
      </MobileShell>
      <PwaRuntime keepalive={!!user} cloud={cloud} />
    </LocaleProvider>
  );
}
