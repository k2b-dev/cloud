import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import { servedStylesheets } from "../_internal/page-stylesheets";
import { registeredCoreRoutes } from "../_internal/runtime-watcher";
import { getLocale } from "../server/locale";
import { resolveAppPresentations } from "../shared/app-presentation";
import { readThemePreferenceFromCookieHeader } from "../shared/theme";
import { resolveCurrentApp } from "./app-appearance";
import type { MinimalLayoutContext } from "./layout-context";
import MinimalLayoutPreferences from "./MinimalLayoutPreferences.island";
import MinimalLayoutPreferencesV2 from "./MinimalLayoutPreferencesV2.island";
import { profilePreferencesMessages } from "./profile-preferences-messages";
import TimezoneCookie from "./TimezoneCookie.island";

/**
 * @deprecated The language and theme settings always sit in the footer; a
 * position is treated like `true`.
 */
export type MinimalLayoutPreferencePosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type MinimalLayoutProps = {
  children: JSX.Element;
  c: MinimalLayoutContext;
  /**
   * Render the footer with legal links and the language and theme settings
   * (default), or `false` for embeds and fixed presentation surfaces.
   */
  preferences?: boolean | MinimalLayoutPreferencePosition;
  /**
   * The page's content is built with `@k2b/ui/v2` (provisional), as `Layout ui="v2"`: it stands in a v2 scope in the
   * app's colour, filling the window above the footer (a visitor page, a form, a kiosk screen). No Cloud chrome; the
   * footer with the legal links and the language and theme settings stays as it is.
   */
  ui?: "v2";
};

/** A v2 page beside an older Core: the frame its sheet lacks, inline (the page fills the window above the footer). */
const OLDER_CORE = {
  page: "display:flex;flex-direction:column;min-height:100dvh",
  // the v2 content paints its own surface, in both themes: the older body has v1's
  main: "display:flex;flex:1 1 auto;min-height:0;min-width:0;background:var(--k2-surface)",
};

export default function MinimalLayout(props: MinimalLayoutProps) {
  const cookie = props.c.req.raw.headers.get("Cookie") ?? "";
  const theme = readThemePreferenceFromCookieHeader(cookie);
  const locale = getLocale(props.c);
  // A v2 page's content is the v2 scope; its app colours sit on the body (see `page.appUi`), from the app that owns the
  // address, as in Layout. A page without the runtime middleware knows no apps and keeps v2's own colour.
  // It links Core's v2.css alone: v2 and Cloud's v2 additions, without v1 and the shell (see `pageStylesheetLinks`).
  // A Core from before that sheet serves no v2.css, and its global.css has neither the v2 frame of this page nor its
  // v2 footer: beside it the page keeps global.css and the v1 footer, and its frame comes inline.
  const v2 = props.ui === "v2";
  const v2Sheet = v2 && servedStylesheets("v2", registeredCoreRoutes()) === "v2";
  if (v2) {
    const page = props.c.get("page");
    const app = resolveCurrentApp(props.c.get("runtime")?.apps ?? [], new URL(props.c.req.raw.url).pathname);
    page.appAccent = app?.appearance?.accent;
    page.appPrimary = app?.appearance?.primary;
    Object.assign(page, v2Sheet ? { appUi: "v2", stylesheets: "v2" } : { appUi: "v2" });
  }
  // Without the footer the main area is the v2 scope; with it, the whole page is (see below), or beside an older Core
  // the main area alone.
  // (A `style` is written only where it is set: Solid's server writes an empty one for `undefined`.)
  const content = (scope: boolean, kiosk: boolean) =>
    !v2 ? (
      props.children
    ) : v2Sheet ? (
      <main class={scope ? "k2-ui minimal-layout-main" : "minimal-layout-main"}>{props.children}</main>
    ) : (
      <main class="k2-ui minimal-layout-main" style={kiosk ? `${OLDER_CORE.main};height:100dvh` : OLDER_CORE.main}>
        {props.children}
      </main>
    );

  if (props.preferences === false) {
    return (
      <LocaleProvider locale={locale}>
        <TimezoneCookie />
        {content(true, true)}
      </LocaleProvider>
    );
  }

  const t = profilePreferencesMessages.resolve([locale]).t;
  // Aggregate every running app's legal links like Layout (last wins on
  // duplicate href). Unlike Layout, MinimalLayout does not require
  // middleware.runtime(); without it the footer has no legal links.
  const apps = resolveAppPresentations(props.c.get("runtime")?.apps ?? [], locale);
  const page = (inner: JSX.Element) =>
    v2Sheet ? (
      <div class="k2-ui minimal-layout" data-ui="v2">
        {inner}
      </div>
    ) : v2 ? (
      <div class="minimal-layout" style={OLDER_CORE.page}>
        {inner}
      </div>
    ) : (
      <div class="minimal-layout">{inner}</div>
    );
  const legalLinks = [...new Map(apps.flatMap((app) => (app.legalLinks ?? []).map((link) => [link.href, link] as const))).values()];

  return (
    <LocaleProvider locale={locale}>
      <TimezoneCookie />
      {/* On v2 the page and its footer are one v2 scope with v2 menus, so it needs no v1 stylesheet. */}
      {page(
        <>
          {content(false, false)}
          <footer class="minimal-layout-footer" data-ui={v2Sheet ? "v2" : undefined}>
            {legalLinks.length > 0 && (
              <nav class="minimal-layout-footer__links" aria-label={t.legalLinks}>
                {legalLinks.map((link) => (
                  // A new tab keeps a started upload or a filled-in form on this page.
                  <a href={link.href} target="_blank" rel="noopener">
                    {link.label}
                  </a>
                ))}
              </nav>
            )}
            {v2Sheet ? <MinimalLayoutPreferencesV2 initialTheme={theme} /> : <MinimalLayoutPreferences initialTheme={theme} />}
          </footer>
        </>,
      )}
    </LocaleProvider>
  );
}
