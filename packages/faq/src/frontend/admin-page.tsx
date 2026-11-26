import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { resolveFaqTranslation } from "../content";
import { faqService } from "../service";
import FaqAdminScreen from "./_components/FaqAdminScreen.island";
import { openFromAddress } from "./_components/faq-admin-open";

/** The FAQ administration on v2: the entries, and the one the address opens (`?entry=<id>` or `?entry=new`). */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const entries = (await faqService.entry.list()).items.map((entry) => ({
    entry,
    question: resolveFaqTranslation(entry.translations, locale).question,
  }));
  // The open entry comes from the list just read, so opening one costs no second statement.
  const open = openFromAddress(entries, c.req.query("entry"));

  return () => (
    <AdminLayout c={c} ui="v2" title="FAQ">
      <FaqAdminScreen nav={adminNavigation(c)} entries={entries} open={open} />
    </AdminLayout>
  );
});
