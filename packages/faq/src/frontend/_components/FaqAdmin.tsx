import { MarkdownView, Placeholder, StatusBadge, useLocale } from "@k2b/ui";
import { resolveFaqTranslation } from "../../content";
import type { FaqEntry } from "../../contracts";
import { faqMessages } from "../messages";
import CreateFaqButton from "./CreateFaqButton.island";
import DeleteFaqButton from "./DeleteFaqButton.island";
import EditFaqButton from "./EditFaqButton.island";

/** The admin list of every entry with its languages, audience and answer; the list draws the hairline between rows. */
export default function FaqAdmin(props: { entries: readonly FaqEntry[] }) {
  const locale = useLocale();
  const t = () => faqMessages.resolve([locale()]).t;
  const audienceLabels = (): Record<string, string> => ({ anonymous: t().anonymous, guest: t().guests, user: t().users });
  return (
    <div class="app-rows">
      <div class="flex flex-wrap items-center justify-between gap-3" style="view-transition-name: admin-faq-toolbar">
        <div class="min-w-0">
          <h1 class="text-base font-semibold text-primary">FAQ</h1>
          <p class="mt-1 text-xs text-dimmed">
            {t().entryCount({ count: props.entries.length })} — {t().visibleAt} <code class="text-[10px]">/faq</code>
          </p>
        </div>
        <CreateFaqButton />
      </div>

      {props.entries.length > 0 ? (
        // Flat (K2, K14): the entries are rows of one list that draws the hairline between them, no frame around it.
        <section class="faq-admin-list k2b-divided" style="view-transition-name: admin-faq-list">
          {props.entries.map((entry) => {
            const content = resolveFaqTranslation(entry.translations, locale());
            return (
              <div class="flex flex-col gap-2 py-3">
                <div class="flex items-start justify-between gap-3">
                  {/* K8: languages and audiences are plain facts, so their chips stay neutral; they keep one meta line
                      of their own under the question (K15). */}
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <h3 class="text-sm font-medium text-primary">{content.question}</h3>
                    <div class="flex flex-wrap items-center gap-1.5">
                      {Object.keys(entry.translations).map((translationLocale) => (
                        <StatusBadge tone="neutral" label={translationLocale} icon={null} />
                      ))}
                      {entry.audience.map((aud) => (
                        <StatusBadge tone="neutral" label={audienceLabels()[aud] ?? aud} icon={null} />
                      ))}
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <EditFaqButton entry={entry} />
                    <DeleteFaqButton id={entry.id} question={content.question} />
                  </div>
                </div>
                <div class="text-sm text-dimmed">
                  <MarkdownView markdown={content.answer} class="markdown-content-sm" />
                </div>
              </div>
            );
          })}
        </section>
      ) : (
        <Placeholder icon="ti ti-help-circle" description={<>{t().noAdminEntries}</>} />
      )}
    </div>
  );
}
