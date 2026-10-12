export type CloudTheme = "light" | "dark";
export type CloudThemePreference = CloudTheme | "system";

const THEME_COOKIE = "theme";
const COOKIE_MAX_AGE_SECONDS = 31536000;

const isCloudTheme = (value: string): value is CloudTheme => value === "light" || value === "dark";

const isCloudThemePreference = (value: string): value is CloudThemePreference => isCloudTheme(value) || value === "system";

const decodeCookieValue = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** More specific legacy paths arrive first; the root choice is the last valid entry. */
const readCookieValue = <T extends string>(
  cookieHeader: string | null | undefined,
  name: string,
  valid: (value: string) => value is T,
): T | undefined => {
  let result: T | undefined;
  for (const part of (cookieHeader ?? "").split(";")) {
    const trimmed = part.trim();
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0 || trimmed.slice(0, separatorIndex) !== name) continue;
    const value = decodeCookieValue(trimmed.slice(separatorIndex + 1));
    if (valid(value)) result = value;
  }
  return result;
};

/** The person's choice; a missing or invalid cookie means Automatic (`system`). */
export const readThemePreferenceFromCookieHeader = (cookieHeader: string | null | undefined): CloudThemePreference =>
  readCookieValue(cookieHeader, THEME_COOKIE, isCloudThemePreference) ?? "system";

/**
 * The resolved theme for server work such as the AI code runtime. For
 * Automatic it is the scheme the browser last reported; browser code reads the
 * `<html>` class instead.
 */
export const readThemeFromCookieHeader = (cookieHeader: string | null | undefined): CloudTheme => {
  const preference = readThemePreferenceFromCookieHeader(cookieHeader);
  return preference === "system" ? (readCookieValue(cookieHeader, "color-scheme", isCloudTheme) ?? "light") : preference;
};

/**
 * Resolves the `<html>` class before first paint, because only the browser
 * knows the device scheme, and follows scheme changes live. It also reports
 * the scheme in the `color-scheme` cookie for the server. A constant, so a CSP
 * hash of it stays valid.
 */
export const themeBootstrapScript = `!function(){var e=document.documentElement;if(e.hasAttribute("data-theme-fixed"))return;var m=matchMedia("(prefers-color-scheme: dark)");function r(n,s){var v;document.cookie.split(";").forEach(function(p){p=p.trim();var i=p.indexOf("=");if(i>0&&p.slice(0,i)===n){var t=p.slice(i+1);try{t=decodeURIComponent(t)}catch(e){}if(t==="light"||t==="dark"||s&&t==="system")v=t}});return v}function a(){var s=m.matches?"dark":"light";if(r("color-scheme")!==s)document.cookie="color-scheme="+s+"; path=/; max-age=31536000; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");var p=r("theme",true)||"system";e.classList.remove("light","dark");e.classList.add(p==="system"?s:p)}a();m.addEventListener("change",function(){a();window.dispatchEvent(new Event("cloud:theme-preference"))})}();`;

const legacyThemeCookiePaths = (pathname: string): string[] => {
  const paths = new Set(["/", "/me", "/app", "/admin"]);
  if (pathname) paths.add(pathname);
  const parts = pathname.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    paths.add(current);
  }
  return [...paths];
};

export const setThemePreference = (mode: CloudThemePreference): CloudThemePreference => {
  if (typeof document === "undefined") return mode;

  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(
    mode === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode,
  );

  const secure = location.protocol === "https:" ? "; Secure" : "";
  for (const path of legacyThemeCookiePaths(location.pathname)) {
    document.cookie = `${THEME_COOKIE}=; path=${path}; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${secure}`;
  }
  document.cookie = `${THEME_COOKIE}=${encodeURIComponent(mode)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  return mode;
};

export const getCurrentThemePreference = (): CloudThemePreference => {
  if (typeof document === "undefined") return "system";
  return readThemePreferenceFromCookieHeader(document.cookie);
};
