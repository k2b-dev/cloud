import { MarkdownView, Placeholder, useLocale } from "@k2b/ui";
import { faqMessages } from "../messages";

/** The public questions as reading text: one 720 px measure, each question a row, a hairline between rows (K2, K11). */
export default function FaqPage(props: { entries: readonly { question: string; answer: string }[] }) {
  const locale = useLocale();
  const t = () => faqMessages.resolve([locale()]).t;
  return (
    // From md no header sits above a signed-in page, so the page keeps its own top and bottom inset.
    <div class="faq-page mx-auto flex w-full max-w-180 flex-col gap-4 md:py-6">
      <h1 class="text-lg font-semibold text-primary" style="view-transition-name: page-header">
        FAQ
      </h1>

      {props.entries.length > 0 ? (
        <div class="faq-list k2b-divided">
          {props.entries.map((entry) => (
            <details class="faq-entry group">
              <summary class="faq-entry__question">
                <i class="ti ti-chevron-right text-sm transition-transform group-open:rotate-90 shrink-0" aria-hidden="true" />
                <span>{entry.question}</span>
              </summary>
              <div class="faq-entry__answer">
                <MarkdownView markdown={entry.answer} class="markdown-content-sm" />
              </div>
            </details>
          ))}
        </div>
      ) : (
        <Placeholder icon="ti ti-help-circle" description={<>{t().noEntries}</>} />
      )}
    </div>
  );
}
