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
