import { z } from "zod";

export const StoreUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        /^https?:\/\/[^/?#\s@\\]+\/?$/i.test(value) &&
        /^https?:$/.test(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !value.includes("?") &&
        !value.includes("#") &&
        (url.pathname === "/" || url.pathname === "")
      );
    } catch {
      return false;
    }
  }, "Use an HTTP or HTTPS origin without credentials, query, fragment, or path.");
export const StoreUser = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
export const StorePassword = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]*$/u);
export const StorePrefix = z
  .string()
  .max(32)
  .regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*_$/);
export const StoreSaveInput = z.object({ url: StoreUrl, user: StoreUser, password: StorePassword.optional() }).strict();
export const StoreSetupInput = z.object({ user: StoreUser.optional(), password: StorePassword }).strict();

/** Only validated identifiers or code constants may reach this function. */
export const quoteIdentifier = (value: string): string => `\`${value.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
