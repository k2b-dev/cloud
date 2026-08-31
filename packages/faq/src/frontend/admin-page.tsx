import { MarkdownView, Placeholder, StatusBadge, type StatusTone } from "@k2b/ui";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../config";
import { resolveFaqTranslation } from "../content";
import { faqService } from "../service";
import CreateFaqButton from "./_components/CreateFaqButton.island";
import DeleteFaqButton from "./_components/DeleteFaqButton.island";
import EditFaqButton from "./_components/EditFaqButton.island";
import { faqMessages } from "./messages";

const AUDIENCE_TONE: Record<string, StatusTone> = {
  anonymous: "neutral",
  guest: "warning",
  user: "running",
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = faqMessages.resolve([locale]);
  const audienceLabels: Record<string, string> = { anonymous: t.anonymous, guest: t.guests, user: t.users };
  const entries = (await faqService.entry.list()).items;

  return () => (
    <AdminLayout c={c} title="FAQ">
      <div class="app-rows">
        <div class="flex flex-wrap items-center justify-between gap-3" style="view-transition-name: admin-faq-toolbar">
          <div class="min-w-0">
            <h1 class="text-base font-semibold text-primary">FAQ</h1>
            <p class="mt-1 text-xs text-dimmed">
              {t.entryCount({ count: entries.length })} — {t.visibleAt} <code class="text-[10px]">/faq</code>
            </p>
          </div>
          <CreateFaqButton />
        </div>

        {entries.length > 0 ? (
          <section class="paper overflow-hidden" style="view-transition-name: admin-faq-list">
            <div class="flex flex-col gap-3 p-3">
              {entries.map((entry) => {
                const content = resolveFaqTranslation(entry.translations, locale);
                return (
                  <div class="flex flex-col gap-2">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                          <h3 class="text-sm font-medium text-primary">{content.question}</h3>
                          {Object.keys(entry.translations).map((translationLocale) => (
                            <StatusBadge tone="neutral" label={translationLocale} icon={null} />
                          ))}
                          {entry.audience.map((aud) => (
                            <StatusBadge tone={AUDIENCE_TONE[aud] ?? "neutral"} label={audienceLabels[aud] ?? aud} icon={null} />
                          ))}
                        </div>
                      </div>
                      <div class="flex shrink-0 items-center gap-1">
                        <EditFaqButton entry={entry} />
                        <DeleteFaqButton id={entry.id} question={content.question} />
                      </div>
                    </div>
                    <div class="text-sm text-dimmed pl-0">
                      <MarkdownView markdown={content.answer} class="markdown-content-sm" />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : (
          <Placeholder surface="paper" description={<>{t.noAdminEntries}</>} />
        )}
      </div>
    </AdminLayout>
  );
});
