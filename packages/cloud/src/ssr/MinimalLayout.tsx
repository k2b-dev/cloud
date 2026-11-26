import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import { getLocale } from "../server/locale";
import { resolveAppPresentations } from "../shared/app-presentation";
import { readThemePreferenceFromCookieHeader } from "../shared/theme";
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

export default function MinimalLayout(props: MinimalLayoutProps) {
  const cookie = props.c.req.raw.headers.get("Cookie") ?? "";
  const theme = readThemePreferenceFromCookieHeader(cookie);
  const locale = getLocale(props.c);
  // A v2 page's content is the v2 scope; its app colours sit on the body (see `page.appUi`).
  // It links Core's v2.css alone: v2 and Cloud's v2 additions, without v1 and the shell (see `pageStylesheetLinks`).
  if (props.ui === "v2") Object.assign(props.c.get("page"), { appUi: "v2", stylesheets: "v2" });
  // Without the footer the main area is the v2 scope; with it, the whole page is (see below).
  const content = (scope: boolean) =>
    props.ui === "v2" ? <main class={scope ? "k2-ui minimal-layout-main" : "minimal-layout-main"}>{props.children}</main> : props.children;

  if (props.preferences === false) {
    return (
      <LocaleProvider locale={locale}>
        <TimezoneCookie />
        {content(true)}
      </LocaleProvider>
    );
  }

  const t = profilePreferencesMessages.resolve([locale]).t;
  // Aggregate every running app's legal links like Layout (last wins on
  // duplicate href). Unlike Layout, MinimalLayout does not require
  // middleware.runtime(); without it the footer has no legal links.
  const apps = resolveAppPresentations(props.c.get("runtime")?.apps ?? [], locale);
  const legalLinks = [...new Map(apps.flatMap((app) => (app.legalLinks ?? []).map((link) => [link.href, link] as const))).values()];

  return (
    <LocaleProvider locale={locale}>
      <TimezoneCookie />
      {/* On v2 the page and its footer are one v2 scope with v2 menus, so it needs no v1 stylesheet. */}
      <div class={props.ui === "v2" ? "k2-ui minimal-layout" : "minimal-layout"} data-ui={props.ui}>
        {content(false)}
        <footer class="minimal-layout-footer" data-ui={props.ui}>
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
          {props.ui === "v2" ? <MinimalLayoutPreferencesV2 initialTheme={theme} /> : <MinimalLayoutPreferences initialTheme={theme} />}
        </footer>
      </div>
    </LocaleProvider>
  );
}
