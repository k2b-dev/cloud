import { MarkdownView, Placeholder } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { getLocale, getUserBackedActor } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../config";
import { faqService } from "../service";
import { faqMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = faqMessages.resolve([getLocale(c)]);
  const user = getUserBackedActor(c);

  const audience = !user ? "anonymous" : user.profile === "guest" ? "guest" : "user";

  const entries = (await faqService.entry.list({ filter: { audience } })).items;

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: "FAQ" }]}>
      <div class="max-w-2xl mx-auto flex flex-col gap-4">
        <h1 class="text-xl font-bold text-primary" style="view-transition-name: page-header">
          FAQ
        </h1>

        {entries.length > 0 ? (
          <div class="flex flex-col gap-2">
            {entries.map((entry) => (
              <details class="paper group">
                <summary class="flex items-start gap-3 cursor-pointer p-4 text-secondary hover:text-primary transition-colors list-none">
                  <i class="ti ti-chevron-right text-sm mt-0.5 transition-transform group-open:rotate-90 shrink-0" />
                  <span class="text-sm font-medium">{entry.question}</span>
                </summary>
                <div class="text-sm text-dimmed px-4 pb-4 pl-10">
                  <MarkdownView markdown={entry.answer} class="markdown-content-sm" />
                </div>
              </details>
            ))}
          </div>
        ) : (
          <Placeholder surface="paper" description={<>{t.noEntries}</>} />
        )}
      </div>
    </Layout>
  );
});
