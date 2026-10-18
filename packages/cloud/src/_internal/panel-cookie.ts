export const PANEL_COOKIE = "cloud_panel";
export const PANEL_MIN_WIDTH_REM = 20;
export const PANEL_MAX_WIDTH_REM = 36;

export type PanelCookieState = { open: boolean; provider?: string; widthRem?: number };
const clampWidth = (value: number) => Math.min(PANEL_MAX_WIDTH_REM, Math.max(PANEL_MIN_WIDTH_REM, value));

export function readPanelCookie(cookieHeader: string | null | undefined, providers: readonly string[]): PanelCookieState {
  const value = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PANEL_COOKIE}=`))
    ?.slice(PANEL_COOKIE.length + 1);
  if (value === undefined) return { open: false };
  const parts = value.split(":");
  const [open, encodedProvider, width] = parts;
  if (
    parts.length !== 3 ||
    (open !== "0" && open !== "1") ||
    encodedProvider === undefined ||
    width === undefined ||
    (width !== "" && !/^\d{1,2}(\.\d{1,2})?$/.test(width))
  )
    return { open: false };
  let provider: string;
  try {
    provider = decodeURIComponent(encodedProvider);
    if (encodeURIComponent(provider) !== encodedProvider) return { open: false };
  } catch {
    return { open: false };
  }
  if ((provider && !providers.includes(provider)) || (open === "1" && !provider)) return { open: false };
  return { open: open === "1", ...(provider ? { provider } : {}), ...(width ? { widthRem: clampWidth(Number(width)) } : {}) };
}

export function serializePanelCookie(state: PanelCookieState, secure: boolean): string {
  const width = state.widthRem !== undefined && Number.isFinite(state.widthRem) ? Math.round(clampWidth(state.widthRem) * 100) / 100 : "";
  return `${PANEL_COOKIE}=${state.open && state.provider ? "1" : "0"}:${encodeURIComponent(state.provider ?? "")}:${width}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Providers whose last consent save ended without a known outcome (a timeout, a lost response). The server may still
 * commit it later, so every document of this browser keeps sharing off and asks again until an answer is saved.
 */
export const PANEL_UNSURE_COOKIE = "cloud_panel_unsure";

export function readPanelUnsure(cookieHeader: string | null | undefined, providers: readonly string[]): string[] {
  const value = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PANEL_UNSURE_COOKIE}=`))
    ?.slice(PANEL_UNSURE_COOKIE.length + 1);
  // Unknown entries are ignored; the list can only name registered providers.
  return value ? [...new Set(value.split(":"))].filter((id) => providers.includes(id)) : [];
}

export function serializePanelUnsure(providers: readonly string[], secure: boolean): string {
  const ids = [...new Set(providers)].filter((id) => /^[a-z][a-z0-9-]*$/.test(id));
  return `${PANEL_UNSURE_COOKIE}=${ids.join(":")}; Path=/; Max-Age=${ids.length ? 86400 : 0}; SameSite=Lax${secure ? "; Secure" : ""}`;
}
