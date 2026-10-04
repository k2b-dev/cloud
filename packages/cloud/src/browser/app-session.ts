import { PWA_AUTH_PATH, PWA_SCOPE } from "../contracts/pwa-paths";

export type AppSessionRenewal = {
  /** The page has a valid app session now. */
  ok: boolean;
  /** Android shares Chrome's cookies with the app, so the web session there may belong to another account. */
  otherAccount?: { name: string };
};

/** Whether this document is a page of the mobile app, whose requests carry the app session. */
export const insideMobileApp = (): boolean =>
  typeof location !== "undefined" && location.pathname.startsWith(PWA_SCOPE) && !location.pathname.startsWith(`${PWA_AUTH_PATH}/`);

const call = async (): Promise<AppSessionRenewal & { renewed: boolean }> => {
  let response: Response;
  try {
    response = await fetch(`${PWA_AUTH_PATH}/session/renew`, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } catch {
    // Offline or unreachable: the next foreground or request tries again.
    return { ok: false, renewed: false };
  }
  if (response.status === 401) {
    // The phone was removed or its pairing ended. Core has already deleted the device key with this answer, so
    // a reload could only show the generic pairing view; the pairing view for a signed-out phone says why.
    location.replace(`${PWA_SCOPE}?pwa=ended`);
    return { ok: false, renewed: false };
  }
  if (response.status === 403) {
    const body: unknown = await response.json().catch(() => null);
    if (typeof body === "object" && body !== null && "code" in body && body.code === "ACCOUNT_BLOCKED") {
      location.replace(`${PWA_SCOPE}?pwa=blocked`);
    }
    return { ok: false, renewed: false };
  }
  if (!response.ok) return { ok: false, renewed: false };
  // `PwaRenewResultSchema`, read by hand: the typed client on every page must not load the validators.
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("renewed" in body) || typeof body.renewed !== "boolean") {
    return { ok: false, renewed: false };
  }
  const other = "otherAccount" in body ? body.otherAccount : undefined;
  const otherAccount =
    typeof other === "object" && other !== null && "name" in other && typeof other.name === "string" ? { name: other.name } : undefined;
  return { ok: true, renewed: body.renewed, otherAccount };
};

let running: Promise<AppSessionRenewal> | undefined;

/**
 * Renews the mobile app's session with the phone's device key through Core. One renewal runs at a time in a page,
 * and every caller shares it. An ended pairing or a blocked account leaves for the app's matching Start view.
 */
export const renewAppSession = (): Promise<AppSessionRenewal> => {
  running ??= (async () => {
    try {
      const first = await call();
      // After a rotation, a second call presents the new key and retires the old one.
      if (first.renewed) await call();
      return { ok: first.ok, otherAccount: first.otherAccount };
    } finally {
      running = undefined;
    }
  })();
  return running;
};
