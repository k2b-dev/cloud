import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { SHARE_ACCESS_SECONDS } from "./service/share-password";

const name = "filesv2-share-access";
export const shareAccessCookie = (c: Context) => getCookie(c, name);
export function setShareAccessCookie(c: Context, kind: "download" | "inbox", token: string, access: string) {
  setCookie(c, name, access, {
    path: `/share/filesv2/${kind === "inbox" ? "inbox" : "s"}/${encodeURIComponent(token)}`,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SHARE_ACCESS_SECONDS,
    secure: new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
  });
}
