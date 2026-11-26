import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import { getLocale } from "../server/locale";
import { resolveAppPresentations } from "../shared/app-presentation";
import { readThemePreferenceFromCookieHeader } from "../shared/theme";
import type { MinimalLayoutContext } from "./layout-context";
import MinimalLayoutPreferences from "./MinimalLayoutPreferences.island";
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
  if (props.ui === "v2") props.c.get("page").appUi = "v2";
  const content = () => (props.ui === "v2" ? <main class="k2-ui minimal-layout-main">{props.children}</main> : props.children);

  if (props.preferences === false) {
    return (
      <LocaleProvider locale={locale}>
        <TimezoneCookie />
        {content()}
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
      <div class="minimal-layout">
        {content()}
        <footer class="minimal-layout-footer">
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
          <MinimalLayoutPreferences initialTheme={theme} />
        </footer>
      </div>
    </LocaleProvider>
  );
}
