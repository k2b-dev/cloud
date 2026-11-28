import type { AuthContext } from "@k2b/cloud/server";
import { ssr } from "../../../config";
import { aiSettingsRedirectHref } from "../ai/area";

/**
 * The former settings page. Every tab moved into an administration area; its addresses lead there with their
 * parameters: the email templates into Outgoing mail, SMTP into sender profiles, storage into Storage, AI into AI.
 */
export default ssr<AuthContext>(async (c) => {
  const url = new URL(c.req.url);
  const rawTab = c.req.query("tab");
  if (rawTab === "mail") return c.redirect("/admin/outgoing-mail", 302);
  if (rawTab === "storage") return c.redirect("/admin/storage", 302);
  const aiHref = aiSettingsRedirectHref(rawTab, c.req.query());
  if (aiHref) return c.redirect(aiHref, 302);
  // The email templates were the last tab and the page's default.
  url.searchParams.delete("tab");
  const rest = url.searchParams.toString();
  return c.redirect(`/admin/outgoing-mail/templates${rest ? `?${rest}` : ""}`, 302);
});
