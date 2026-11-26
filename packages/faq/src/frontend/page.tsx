import type { AuthContext } from "@k2b/cloud/server";
import { getLocale, getUserBackedActor } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { faqService } from "../service";
import FaqScreen from "./_components/FaqScreen";
import { faqMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = faqMessages.resolve([locale]);
  const user = getUserBackedActor(c);

  const audience = !user ? "anonymous" : user.profile === "guest" ? "guest" : "user";

  const entries = (await faqService.entry.listResolved({ filter: { audience }, locale })).items;

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: "FAQ" }]}>
      <FaqScreen t={t} entries={entries.map((entry) => ({ id: entry.id, question: entry.question, answer: entry.answer }))} />
    </Layout>
  );
});
