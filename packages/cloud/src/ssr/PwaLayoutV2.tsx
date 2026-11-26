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
export const bareDrops = (props: Pick<PwaLayoutProps, "back" | "actions" | "sidebarTitle">): string[] =>
  [props.back && "back", props.actions !== undefined && "actions", props.sidebarTitle !== undefined && "sidebarTitle"].filter(
    (name): name is string => typeof name === "string",
  );

/** A Tabler icon name from a part's icon class (`ti ti-mail`). */
const iconName = (icon: string) => icon.replace(/^ti\s+ti-/, "");

/**
 * `PwaLayout ui="v2"`: the frame of a Cloud app page built with `@k2b/ui/v2`, phone first. The page loads Core's
 * v2.css alone and no v1 shell code. Below 48rem the page fills the window with its head at the top and a tab bar of
 * Start and the first parts at the bottom, both clear of the phone's safe areas; from 48rem a v2 `Nav` with Start,
 * every part and Settings stands beside the page instead. Without `bare` the frame puts the page's content in a
 * `Workspace` with the head (back, title, actions) and one scrolling `Pane`; with `bare` the page brings its own
 * `Workspace` from its island, and the frame keeps only the navigation.
 */
export default function PwaLayoutV2(props: PwaLayoutProps) {
  const { locale, t, user, cloud, page, parts, path, builds, countRoutes, tabs, currentTab, settingsHref, currentPart } = pwaFrame(
    props.c,
    props.title,
  );
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
  const tabItems: PwaNavEntry[] = navigation
    ? [
        { id: "start", label: t.start, icon: "home", href: PWA_SCOPE, current: !currentTab },
        ...tabs.map((part) => ({ ...entry(part), current: part === currentTab })),
      ]
    : [];
  const back = props.back;
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
          <Show
            when={props.sidebarTitle !== undefined && props.sidebarTitle !== props.title}
            fallback={<Text weight="strong">{props.title}</Text>}
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
      // The app has no phone bar of the shell, where a v2 head's end goes below 768 px: the page's actions stay.
      end={
        props.actions === undefined ? undefined : (
          <span class="pwa-v2-actions" data-keep="">
            {props.actions}
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
      >
        <Show when={user}>
          <PwaNavigationV2
            title={cloud}
            start={{ id: "start", label: t.start, icon: "home", href: PWA_SCOPE, current: path === PWA_SCOPE }}
            appsLabel={t.apps}
            parts={parts.map(entry)}
            settings={{ id: "settings", label: t.settings, icon: "settings", href: settingsHref, current: path === settingsHref }}
            tabsLabel={t.tabs}
            tabs={tabItems}
            endpoints={countRoutes}
          />
        </Show>
        <main class="pwa-v2-main">
          {props.bare ? (
            props.children
          ) : (
            <Workspace head={head}>
              <Pane label={props.title}>{props.children}</Pane>
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
