import { LocaleProvider } from "@k2b/ui";
import { Bar, Button, Pane, Text, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { env } from "../config/env";
import { PWA_COOKIES, PWA_LIMITS, PWA_SCOPE } from "../contracts/pwa";
import type { PwaLayoutProps } from "./PwaLayout";
import PwaNavigationV2, { type PwaNavEntry } from "./PwaNavigationV2.island";
import PwaRuntimeV2 from "./PwaRuntimeV2.island";
import { pwaFrame } from "./pwa-frame";
import TimezoneCookie from "./TimezoneCookie.island";

/** The props of the frame's head that a bare page leaves out. */
export const bareDrops = (props: Pick<PwaLayoutProps, "back" | "actions" | "sidebarTitle" | "status">): string[] =>
  [
    props.back && "back",
    props.actions !== undefined && "actions",
    props.sidebarTitle !== undefined && "sidebarTitle",
    props.status !== undefined && "status",
  ].filter((name): name is string => typeof name === "string");

/** The installation's logo, as Core serves it. */
const LOGO = "/branding/logo";

/** A Tabler icon name from a part's icon class (`ti ti-mail`). */
const iconName = (icon: string) => icon.replace(/^ti\s+ti-/, "");

/**
 * `PwaLayout ui="v2"`: the frame of a Cloud app page built with `@k2b/ui/v2`, phone first. The page loads Core's
 * v2.css alone and no v1 shell code. Below 48rem the page fills the window with its head at the top and a tab bar of
 * Start and the first parts at the bottom, both clear of the phone's safe areas; from 48rem a v2 `Nav` with Start,
 * every part and Settings stands beside the page instead, a `Rail` as Cloud's app bar.
 * There the head shows no title that only names the open place, and a head left empty by that leaves. Without `bare` the frame puts the page's content in a
 * `Workspace` with the head (back, title, actions) and one scrolling `Pane`; with `bare` the page brings its own
 * `Workspace` from its island, and the frame keeps only the navigation.
 */
export default function PwaLayoutV2(props: PwaLayoutProps) {
  const { locale, t, user, cloud, page, parts, path, builds, countRoutes, settingsHref, currentPart } = pwaFrame(props.c, props.title);
  // Its app colours sit on the body; it links Core's v2.css alone, without v1 and the shell (see `pageStylesheetLinks`).
  Object.assign(page, { appUi: "v2", stylesheets: "v2" });
  // A bare page brings its own head: what the frame's head would show is not shown, which an author should learn at once.
  const dropped = props.bare ? bareDrops(props) : [];
  if (dropped.length > 0 && env.IS_DEVELOPMENT)
    console.warn(`PwaLayout ui="v2" bare "${props.title}": ${dropped.join(", ")} not shown; a bare page puts them in its own head.`);
  const navigation = !!user && parts.length > 0;
  const entry = (part: (typeof parts)[number]): PwaNavEntry => ({
    id: part.id,
    label: part.name,
    icon: iconName(part.icon),
    href: part.pwa.href,
    current: part === currentPart,
    ...(part.pwa.badge ? { badge: part.pwa.badge } : {}),
    ...(part.pwa.summary ? { summary: part.pwa.summary } : {}),
  });
  // Start and every part: the tab bar shows four and "More" with the others. Settings is no tab, so none is marked there.
  const start: PwaNavEntry = { id: "start", label: t.start, icon: "home", href: PWA_SCOPE, current: path === PWA_SCOPE };
  const tabItems: PwaNavEntry[] = navigation ? [start, ...parts.map(entry)] : [];
  const back = props.back;
  // the frame owns the way to Settings: pages never add their own
  const settingsOnStart = !!user && path === PWA_SCOPE;
  // Beside the rail, a title that only names the open place says nothing the rail does not; the phone keeps it.
  const wideTitle = props.sidebarTitle ?? props.title;
  const openPlace = path === PWA_SCOPE ? t.start : path === settingsHref ? t.settings : currentPart?.name;
  const titleRepeats = !!user && wideTitle === openPlace;
  // Then a head with nothing else beside the rail leaves there (no back the rail leads to, no actions).
  const wideHeadEmpty = titleRepeats && (!back || back.withSidebar === false) && props.actions === undefined;
  const head = (
    <Bar
      start={
        <span class="pwa-v2-title">
          <Show when={back}>
            {(link) => (
              <span class="pwa-v2-back" data-with-sidebar={link().withSidebar === false ? "hide" : undefined}>
                <Button variant="ghost" icon="arrow-left" href={link().href} label={link().label} />
              </span>
            )}
          </Show>
          {/* Start carries the installation's logo on the phone, where no sidebar shows it */}
          <Show when={path === PWA_SCOPE}>
            <img class="pwa-v2-logo pwa-v2-phone-only" src={LOGO} alt="" />
          </Show>
          <Show
            when={!titleRepeats && props.sidebarTitle !== undefined && props.sidebarTitle !== props.title}
            fallback={
              <Show when={titleRepeats} fallback={<Text weight="strong">{props.title}</Text>}>
                <span class="pwa-v2-phone-only">
                  <Text weight="strong">{props.title}</Text>
                </span>
              </Show>
            }
          >
            <span class="pwa-v2-phone-only">
              <Text weight="strong">{props.title}</Text>
            </span>
            <span class="pwa-v2-wide-only">
              <Text weight="strong">{props.sidebarTitle}</Text>
            </span>
          </Show>
        </span>
      }
      // The app has no phone bar of the shell, where a v2 head's end goes below 768 px: the page's actions stay. Start
      // carries the way to Settings on the phone, which is no tab; beside it the rail's foot leads there.
      end={
        props.actions === undefined && !settingsOnStart ? undefined : (
          <span class="pwa-v2-actions" data-keep="">
            {props.actions}
            <Show when={settingsOnStart}>
              <span class="pwa-v2-phone-only">
                <Button variant="ghost" icon="settings" label={t.settings} href={settingsHref} />
              </span>
            </Show>
          </span>
        )
      }
    />
  );

  return (
    <LocaleProvider locale={locale}>
      {/* Pages without a person show no times. Their pairing link lives only in memory, and a reload would lose it. */}
      <TimezoneCookie reload={!!user} />
      <div
        class="k2-ui pwa-v2"
        data-ui="v2"
        data-tabs={navigation ? "" : undefined}
        data-screen={props.screen ? "" : undefined}
        data-sidebar={user ? "" : undefined}
        data-wide-head={wideHeadEmpty && !props.bare ? "none" : undefined}
      >
        <Show when={user}>
          <PwaNavigationV2
            title={cloud}
            logo={LOGO}
            start={start}
            parts={parts.map(entry)}
            settings={{ id: "settings", label: t.settings, icon: "settings", href: settingsHref, current: path === settingsHref }}
            tabsLabel={t.tabs}
            tabs={tabItems}
            screen={props.screen || undefined}
            endpoints={countRoutes}
          />
        </Show>
        <main class="pwa-v2-main">
          {props.bare ? (
            props.children
          ) : (
            <Workspace head={head}>
              <Pane label={props.title} status={props.status}>
                {props.children}
              </Pane>
            </Workspace>
          )}
        </main>
        <PwaRuntimeV2
          keepalive={!!user}
          accountId={user?.id}
          builds={builds}
          cloud={cloud}
          rememberAddress={page.pwaAddress ? { cookie: PWA_COOKIES.lastAddress, maxAge: PWA_LIMITS.idleDays * 86_400 } : undefined}
        />
      </div>
    </LocaleProvider>
  );
}
