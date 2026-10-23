import { LocaleProvider, MobileShell, TabBar, type TabBarItem } from "@k2b/ui";
import type { JSX } from "solid-js";
import { PWA_SCOPE } from "../contracts/pwa";
import { getLocale } from "../server/locale";
import { visiblePwaParts } from "./app-navigation";
import type { LayoutContext } from "./layout-context";
import PwaRuntime from "./PwaRuntime.island";
import { pwaMessages } from "./pwa-messages";
import { getRuntimeContext } from "./runtime";
import TimezoneCookie from "./TimezoneCookie.island";

/** Parts with their own tab; Start lists every part and doubles as "More". */
const TAB_PARTS = 3;

export type PwaLayoutProps = {
  /** The request context; the layout also sets the page's framing and referrer headers. */
  c: LayoutContext & { header(name: string, value: string): void };
  /** Header heading and document title. */
  title: string;
  /** The heading beside the sidebar from 48rem, which already names the installation; `title` by default. */
  sidebarTitle?: string;
  /**
   * Up-navigation inside the part, for example from a detail back to its list. `withSidebar: false` hides it beside
   * the sidebar, which already leads there.
   */
  back?: { href: string; label: string; withSidebar?: boolean };
  /** At most two icon buttons at the header end. */
  actions?: JSX.Element;
  /**
   * The page brings its own heads and scroll areas, such as `AppWorkspace.Main` levels; the frame keeps only its
   * navigation. `title` still names the document.
   */
  bare?: boolean;
  children: JSX.Element;
};

/**
 * The frame of every page in the installable mobile app (preview): the app's document head, a phone shell with a
 * tab bar of Start and the first parts, from 48rem a sidebar with Start, every part and Settings instead, and the
 * browser runtime (service worker, offline notice, session keepalive). Pages render it below `/pwa/` with
 * `ssr.pwaAccess`.
 */
export default function PwaLayout(props: PwaLayoutProps) {
  const { c } = props;
  const locale = getLocale(c);
  const t = pwaMessages.resolve([locale]).t;
  const user = c.get("user");
  const cloud = c.get("settings")?.app?.name || "Cloud";
  const page = c.get("page");
  page.title = props.title;
  page.pwa = { name: cloud };
  // No app page may be framed, and none leaks its address to another site.
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", "frame-ancestors 'none'");

  const parts = visiblePwaParts(getRuntimeContext(c).apps, user, locale);
  const path = new URL(c.req.raw.url).pathname;
  const tabs = parts.slice(0, TAB_PARTS);
  const currentTab = tabs.find((part) => path === part.pwa.href || path.startsWith(`${part.pwa.href}/`));
  // Start is titled with the installation's name; a part's first page carries the part's name.
  const items: TabBarItem[] = [
    { id: "start", label: t.start, title: cloud, icon: "ti ti-home", href: PWA_SCOPE, current: !currentTab },
    ...tabs.map((part) => ({ id: part.id, label: part.name, icon: part.icon, href: part.pwa.href, current: part === currentTab })),
  ];
  // The sidebar names the installation itself, so Start is titled Start there; Settings is a destination of its own.
  const settingsHref = `${PWA_SCOPE}settings`;
  const currentPart = parts.find((part) => path === part.pwa.href || path.startsWith(`${part.pwa.href}/`));
  const sidebar = (
    <MobileShell.Sidebar
      label={t.tabs}
      title={cloud}
      logo="/branding/logo"
      items={[{ id: "start", label: t.start, icon: "ti ti-home", href: PWA_SCOPE, current: path === PWA_SCOPE }]}
      sections={[
        {
          title: t.apps,
          items: parts.map((part) => ({ id: part.id, label: part.name, icon: part.icon, href: part.pwa.href, current: part === currentPart })),
        },
      ]}
      footer={[{ id: "settings", label: t.settings, icon: "ti ti-settings", href: settingsHref, current: path === settingsHref }]}
    />
  );

  return (
    <LocaleProvider locale={locale}>
      {/* Pages without a person show no times. Their pairing link lives only in memory, and a reload would lose it. */}
      <TimezoneCookie reload={!!user} />
      <MobileShell
        header={<MobileShell.Header title={props.title} sidebarTitle={props.sidebarTitle} back={props.back} actions={props.actions} />}
        scroll={!props.bare}
        footer={user && parts.length > 0 ? <TabBar label={t.tabs} items={items} /> : undefined}
        sidebar={user ? sidebar : undefined}
      >
        {props.children}
      </MobileShell>
      <PwaRuntime keepalive={!!user} cloud={cloud} />
    </LocaleProvider>
  );
}
