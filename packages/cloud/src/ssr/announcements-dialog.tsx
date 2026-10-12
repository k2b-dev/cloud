import { Button, dialogCore, MarkdownView, PanelDialog, panelDialogOptions, useLocale } from "@k2b/ui";
import { For } from "solid-js";
import {
  ANNOUNCEMENTS_COOKIE,
  ANNOUNCEMENTS_COOKIE_MAX_AGE_SECONDS,
  mergeAnnouncementCookieState,
  parseAnnouncementCookieHeader,
  serializeAnnouncementCookieState,
} from "../contracts/announcement-cookie";
import type { AnnouncementDisplayEntry } from "../contracts/announcements";
import { platformMessages } from "./platform-messages";

function AnnouncementsPanel(props: { entries: AnnouncementDisplayEntry[]; close: () => void }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().announcements}
        subtitle={t().latestPlatformUpdates}
        icon="ti ti-speakerphone text-blue-500"
        close={props.close}
      />
      <PanelDialog.Body>
        <For each={props.entries}>
          {(entry) => (
            <article class="panel-dialog-section rounded-[var(--ui-radius-surface)] p-4">
              <div class="mb-3 flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <h2 class="text-base font-semibold text-primary">{entry.title}</h2>
                  <p class="mt-0.5 text-xs text-dimmed">
                    {new Date(entry.publishedAt).toLocaleDateString(locale(), {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                </div>
                <span class="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-dimmed dark:bg-zinc-800">v{entry.version}</span>
              </div>
              <MarkdownView trustedHtml={entry.bodyHtml} />
            </article>
          )}
        </For>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <Button size="sm" onClick={props.close}>
          {t().gotIt}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

/** Shows the announcements the person has not seen yet, and records them as seen once the dialog closes. */
export function openAnnouncementsDialog(props: { entries: AnnouncementDisplayEntry[]; latestVersion: number }) {
  void dialogCore
    .open<void>((close) => <AnnouncementsPanel entries={props.entries} close={() => close()} />, panelDialogOptions)
    .then(() => {
      const next = mergeAnnouncementCookieState(parseAnnouncementCookieHeader(document.cookie), {
        seenAnnouncementVersion: props.latestVersion,
      });
      document.cookie = `${ANNOUNCEMENTS_COOKIE}=${serializeAnnouncementCookieState(next)}; Path=/; Max-Age=${ANNOUNCEMENTS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
    });
}
