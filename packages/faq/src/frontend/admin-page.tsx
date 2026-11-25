import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { resolveFaqTranslation } from "../content";
import { faqService } from "../service";
import FaqAdminScreen from "./_components/FaqAdminScreen.island";
import { openFromAddress } from "./_components/faq-admin-open";
import { faqMessages } from "./messages";

/** The FAQ administration on v2: the entries, and the one the address opens (`?entry=<id>` or `?entry=new`). */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = faqMessages.resolve([locale]);
  const entries = (await faqService.entry.list()).items.map((entry) => ({
    entry,
    question: resolveFaqTranslation(entry.translations, locale).question,
  }));
  // The open entry comes from the list just read, so opening one costs no second statement.
  const open = openFromAddress(entries, c.req.query("entry"));

  // k2b-ui gap: AdminLayout has no v2 form yet; this page uses Layout ui="v2" until it does (the shell trail leads to Admin).
  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.admin, href: "/admin" }, { title: "FAQ" }]}>
      <FaqAdminScreen entries={entries} open={open} />
    </Layout>
  );
});
