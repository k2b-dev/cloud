import { LocaleProvider, MobileShell, TabBar, type TabBarItem } from "@k2b/ui";
import type { JSX } from "solid-js";
import { servedStylesheets } from "../_internal/page-stylesheets";
import { registeredCoreRoutes } from "../_internal/runtime-watcher";
import { PWA_COOKIES, PWA_LIMITS, PWA_SCOPE } from "../contracts/pwa";
import type { LayoutContext } from "./layout-context";
import PwaLayoutV2 from "./PwaLayoutV2";
import PwaPartCount from "./PwaPartCount.island";
import PwaRuntime from "./PwaRuntime.island";
import { pwaFrame } from "./pwa-frame";
import TimezoneCookie from "./TimezoneCookie.island";

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
  /**
   * The page opens as a screen of its own below 48rem, such as one chat with its composer at the bottom edge: the tab
   * bar steps aside. A part that changes this in place calls `MobileShell.setScreen` from `@k2b/ui`, on v2
   * `setPwaScreen` from `@k2b/cloud/browser/pwa-screen`.
   */
  screen?: boolean;
  /**
   * The page is built with `@k2b/ui/v2` (provisional): the frame is v2 too, and the page loads Core's v2.css alone.
   * Without `bare` the frame holds the content in a `Workspace` with the head and one `Pane`; with `bare` the page
   * returns its own `Workspace`. Beside a Core without v2.css the page keeps the v1 frame, its content in a v2 scope.
   */
  ui?: "v2";
  children: JSX.Element;
};

/** A bare v2 page in the v1 frame fills the shell's area, as its `Workspace` expects; inline, since the frame's
 * stylesheet is the older Core's. */
const FILL = "display:flex;flex:1 1 auto;flex-direction:column;min-width:0;min-height:0";

/**
 * The frame of every page in the installable mobile app (preview): the app's document head, a phone shell with a
 * tab bar of Start and the first parts, from 48rem a sidebar with Start, every part and Settings instead, and the
 * browser runtime (service worker, offline notice, session keepalive). Pages render it below `/pwa/` with
 * `ssr.pwaAccess`.
 */
export default function PwaLayout(props: PwaLayoutProps) {
  // A Core from before the v2 frame serves no v2.css, and its global.css holds no rules for that frame: beside it the
  // page keeps the v1 frame, with its own v2 content in a v2 scope.
  const v2 = props.ui === "v2";
  if (v2 && servedStylesheets("v2", registeredCoreRoutes()) === "v2") return <PwaLayoutV2 {...props} />;
  const { c } = props;
  const { locale, t, user, cloud, page, parts, path, builds, countRoutes, tabs, currentTab, settingsHref, currentPart } = pwaFrame(
    c,
    props.title,
  );
  if (v2) page.appUi = "v2";
  // Read inside the LocaleProvider below: the page's content takes the request's locale from it.
  const content = () =>
    v2 ? (
      <div class="k2-ui" data-ui="v2" style={props.bare ? FILL : undefined}>
        {props.children}
      </div>
    ) : (
      props.children
    );
  const badge = (part: (typeof parts)[number]) =>
    part.pwa.badge ? <PwaPartCount endpoint={part.pwa.badge} endpoints={countRoutes} attention /> : undefined;
  // Start is titled with the installation's name; a part's first page carries the part's name.
  const items: TabBarItem[] = [
    { id: "start", label: t.start, title: cloud, icon: "ti ti-home", href: PWA_SCOPE, current: !currentTab },
    ...tabs.map((part) => ({
      id: part.id,
      label: part.name,
      icon: part.icon,
      href: part.pwa.href,
      current: part === currentTab,
      badge: badge(part),
    })),
  ];
  // The sidebar names the installation itself, so Start is titled Start there; Settings is a destination of its own.
  const sidebar = (
    <MobileShell.Sidebar
      label={t.tabs}
      title={cloud}
      logo="/branding/logo"
      items={[{ id: "start", label: t.start, icon: "ti ti-home", href: PWA_SCOPE, current: path === PWA_SCOPE }]}
      sections={[
        {
          title: t.apps,
          items: parts.map((part) => ({
            id: part.id,
            label: part.name,
            icon: part.icon,
            href: part.pwa.href,
            current: part === currentPart,
            badge: badge(part),
            count: part.pwa.summary ? <PwaPartCount endpoint={part.pwa.summary} endpoints={countRoutes} /> : undefined,
          })),
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
        screen={props.screen}
        footer={user && parts.length > 0 ? <TabBar label={t.tabs} items={items} /> : undefined}
        sidebar={user ? sidebar : undefined}
      >
        {content()}
      </MobileShell>
      <PwaRuntime
        keepalive={!!user}
        accountId={user?.id}
        builds={builds}
        cloud={cloud}
        rememberAddress={page.pwaAddress ? { cookie: PWA_COOKIES.lastAddress, maxAge: PWA_LIMITS.idleDays * 86_400 } : undefined}
      />
    </LocaleProvider>
  );
}
