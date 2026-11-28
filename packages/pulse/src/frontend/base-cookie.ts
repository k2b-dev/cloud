import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { SHORT_ID_REGEX } from "../lib/short-id";

/** The base a person worked in last, by its public id: `/app/pulse` opens it again. */
export const PULSE_BASE_COOKIE = "pulse_base";
const YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Every page of a base remembers it; only Pulse's own pages read it. */
export const rememberBase = (c: Context, publicBaseId: string) =>
  setCookie(c, PULSE_BASE_COOKIE, publicBaseId, {
    path: "/app/pulse",
    sameSite: "Lax",
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
    maxAge: YEAR_SECONDS,
  });

/** The remembered base's public id, or null when the cookie is missing or names no public id. */
export const rememberedBase = (c: Context): string | null => {
  const value = getCookie(c, PULSE_BASE_COOKIE);
  return value && SHORT_ID_REGEX.test(value) ? value : null;
};
