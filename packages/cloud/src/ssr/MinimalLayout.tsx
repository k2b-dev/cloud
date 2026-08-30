import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import { getLocale } from "../server/locale";
import { readThemeFromCookieHeader } from "../shared/theme";
import type { MinimalLayoutContext } from "./layout-context";
import LayoutPreferences from "./LayoutPreferences.island";
import TimezoneCookie from "./TimezoneCookie.island";

export type MinimalLayoutPreferencePosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type MinimalLayoutProps = {
  children: JSX.Element;
  c: MinimalLayoutContext;
  /** Position the shared language/theme control, or disable it entirely. */
  preferences?: MinimalLayoutPreferencePosition | false;
};

const menuPosition = (position: MinimalLayoutPreferencePosition) => {
  if (position === "top-left") return "bottom-right" as const;
  if (position === "top-right") return "bottom-left" as const;
  if (position === "bottom-left") return "top-right" as const;
  return "top-left" as const;
};

export default function MinimalLayout(props: MinimalLayoutProps) {
  const cookie = props.c.req.raw.headers.get("Cookie") ?? "";
  const theme = readThemeFromCookieHeader(cookie);
  const locale = getLocale(props.c);
  const preferences = props.preferences === undefined ? "bottom-right" : props.preferences;
  props.c.get("page").theme = theme;

  return (
    <LocaleProvider locale={locale}>
      <TimezoneCookie />
      {props.children}
      {preferences !== false && (
        <LayoutPreferences
          class={`minimal-layout-preferences minimal-layout-preferences--${preferences}`}
          initialTheme={theme}
          position={menuPosition(preferences)}
          triggerClass="minimal-layout-preferences__trigger"
        />
      )}
    </LocaleProvider>
  );
}
