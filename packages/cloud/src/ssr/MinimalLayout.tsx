import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import { getLocale } from "../server/locale";
import { resolveAppPresentations } from "../shared/app-presentation";
import { readThemeFromCookieHeader } from "../shared/theme";
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
};

export default function MinimalLayout(props: MinimalLayoutProps) {
  const cookie = props.c.req.raw.headers.get("Cookie") ?? "";
  const theme = readThemeFromCookieHeader(cookie);
  const locale = getLocale(props.c);
  props.c.get("page").theme = theme;

  if (props.preferences === false) {
    return (
      <LocaleProvider locale={locale}>
        <TimezoneCookie />
        {props.children}
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
        {props.children}
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
