import { PWA_AUTH_PATH, PWA_SCOPE, type PwaPlatform } from "@k2b/cloud/contracts";

/** An answer of Core's phone endpoints; `status` 0 means the request did not reach Cloud. */
export type PhoneAnswer = { status: number; code?: string; body: unknown };

const request = async (method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<PhoneAnswer> => {
  let response: Response;
  try {
    response = await fetch(`${PWA_AUTH_PATH}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { status: 0, body: null };
  }
  const json: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  const code = typeof json === "object" && json !== null && "code" in json && typeof json.code === "string" ? json.code : undefined;
  return { status: response.status, code, body: json };
};

/** Core's phone-side endpoints below `/pwa/_auth`. Their credentials are HttpOnly cookies this page never sees. */
export const phoneAuth = {
  claim: (secret: string, platform: PwaPlatform) => request("POST", "/pairings/claim", { secret, platform }),
  complete: () => request("POST", "/pairings/complete"),
  renew: () => request("POST", "/session/renew"),
  rename: (name: string) => request("PATCH", "/session", { name }),
  signOut: () => request("DELETE", "/session"),
};

/**
 * The phone's system, from the operating system alone. The installed app on iPhone may look like a browser inside
 * another app, so the installation guide's classification would name it wrongly.
 */
export const phonePlatform = (): PwaPlatform => {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  return /Android/.test(navigator.userAgent) ? "android" : "other";
};

/** Running from the Home Screen. */
export const isStandalone = (): boolean =>
  matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && navigator.standalone === true);

/**
 * Takes a pairing link out of the address before anything else can read or record it, now and whenever the running
 * app receives one, and hands it over in memory only. Returns the cleanup.
 */
export const watchPairingLink = (onLink: (link: string) => void): (() => void) => {
  const take = () => {
    if (!location.hash.startsWith("#pair=")) return;
    // The launch bounce may have added a state to the address; the link itself is the scope and the fragment.
    const link = `${location.origin}${PWA_SCOPE}${location.hash}`;
    history.replaceState(history.state, "", location.pathname + location.search);
    onLink(link);
  };
  take();
  window.addEventListener("hashchange", take);
  return () => window.removeEventListener("hashchange", take);
};
