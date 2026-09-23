import { Button, StatusBadge, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import { contactDirectoryMessages } from "../../contact-directory-messages";
import { usesContactDirectoryDefaults } from "../../contact-directory-settings";
import type { ContactDirectoryAdminView } from "../../service/contact-directory";
import { openMailContactDirectoryDialog } from "./MailContactDirectoryDialog";

/** Compact summary of Mail's contact directory on the Mail admin page; the editor opens in a dialog. */
export default function MailAdminContactDirectory(props: { view: ContactDirectoryAdminView }) {
  const locale = useLocale();
  const t = createMemo(() => contactDirectoryMessages.resolve([locale()]).t);
  const [view, setView] = createSignal(props.view);
  const appName = () => view().apps?.find((app) => app.appId === view().config.appId)?.appName ?? view().config.appId;

  const configure = async () => {
    const saved = await openMailContactDirectoryDialog(view(), locale());
    if (saved) setView((current) => ({ ...current, config: saved, issues: [] }));
  };

  return (
    <section class="paper flex flex-wrap items-center gap-3 px-3 py-3" aria-labelledby="mail-contact-directory-summary-title">
      <i class="ti ti-address-book text-dimmed" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <h2 id="mail-contact-directory-summary-title" class="text-xs font-semibold text-primary">
          {t().title}
        </h2>
        <p class="truncate text-xs text-secondary" data-testid="mail-contact-directory-summary">
          {appName()} · {usesContactDirectoryDefaults(view().config) ? t().defaults : t().custom}
        </p>
      </div>
      <Show when={view().issues.length > 0}>
        <StatusBadge tone="warning" label={t().needsAttention} />
      </Show>
      <Button variant="secondary" size="sm" type="button" onClick={() => void configure()}>
        <i class="ti ti-adjustments" aria-hidden="true" /> {t().configure}
      </Button>
    </section>
  );
}
