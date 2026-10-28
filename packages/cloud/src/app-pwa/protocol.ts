/** Browser-safe QR protocol. Parsing never navigates or fetches the scanned URL. */
export type AppPwaQr = { kind: "device" | "visit"; secret: string };
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export const appPwaQr = (origin: string, path: string, value: AppPwaQr): string => {
  if (!SECRET.test(value.secret)) throw new Error("Invalid App-PWA secret");
  return `${origin}${path}#cloud-app-pwa:${value.kind}:${value.secret}`;
};

/** Exact serialized comparison rejects normalization, escapes, alternate ports, userinfo, query, and whitespace. */
export const parseAppPwaQr = (text: string, origin: string, path: string): AppPwaQr | null => {
  const prefix = `${origin}${path}#cloud-app-pwa:`;
  if (text.length !== prefix.length + 7 + 43 && text.length !== prefix.length + 6 + 43) return null;
  if (!text.startsWith(prefix)) return null;
  const value = text.slice(prefix.length);
  const kind = value.startsWith("device:") ? "device" : value.startsWith("visit:") ? "visit" : null;
  if (!kind) return null;
  const secret = value.slice(kind.length + 1);
  return SECRET.test(secret) && text === appPwaQr(origin, path, { kind, secret }) ? { kind, secret } : null;
};

/** Drop a directly opened fragment before asynchronous work; the supported input remains the scanner. */
export const clearAppPwaFragment = (): void => {
  if (typeof window !== "undefined" && window.location.hash) {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
};
