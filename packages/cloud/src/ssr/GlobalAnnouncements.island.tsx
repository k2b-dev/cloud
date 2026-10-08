import { Button, dialogCore, IconButton, MarkdownView, NoticeCard, PanelDialog, panelDialogOptions, useLocale } from "@k2b/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import {
  ANNOUNCEMENTS_COOKIE,
  ANNOUNCEMENTS_COOKIE_MAX_AGE_SECONDS,
  type AnnouncementCookieState,
  type AnnouncementDisplayEntry,
  mergeAnnouncementCookieState,
  serializeAnnouncementCookieState,
} from "../contracts/announcements";
import { platformMessages } from "./platform-messages";

type Props = {
  banners: AnnouncementDisplayEntry[];
  announcements: AnnouncementDisplayEntry[];
  latestAnnouncementVersion: number;
  cookieState: AnnouncementCookieState;
};

const writeCookieState = (state: AnnouncementCookieState) => {
  document.cookie = `${ANNOUNCEMENTS_COOKIE}=${serializeAnnouncementCookieState(state)}; Path=/; Max-Age=${ANNOUNCEMENTS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
};

export default function GlobalAnnouncements(props: Props) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const [cookieState, setCookieState] = createSignal(props.cookieState);
  const [banners, setBanners] = createSignal(props.banners);

  const dismissBanner = (version: number) => {
    const next = mergeAnnouncementCookieState(cookieState(), { dismissedBannerVersions: [version] });
    setCookieState(next);
    writeCookieState(next);
    setBanners((items) => items.filter((item) => item.version !== version));
  };

  const closeAnnouncements = () => {
    const next = mergeAnnouncementCookieState(cookieState(), {
      seenAnnouncementVersion: props.latestAnnouncementVersion,
    });
    setCookieState(next);
    writeCookieState(next);
  };

  onMount(() => {
    if (props.announcements.length === 0) return;

    void dialogCore
      .open<void>(
        (close) => (
          <PanelDialog>
            <PanelDialog.Header
              title={t().announcements}
              subtitle={t().latestPlatformUpdates}
              icon="ti ti-speakerphone text-blue-500"
              close={() => close()}
            />
            <PanelDialog.Body>
              <For each={props.announcements}>
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
                      <span class="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-dimmed dark:bg-zinc-800">
                        v{entry.version}
                      </span>
                    </div>
                    <MarkdownView trustedHtml={entry.bodyHtml} />
                  </article>
                )}
              </For>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <span />
              <Button size="sm" onClick={() => close()}>
                {t().gotIt}
              </Button>
            </PanelDialog.Footer>
          </PanelDialog>
        ),
        panelDialogOptions,
      )
      .then(closeAnnouncements);
  });

  return (
    <Show when={banners().length > 0}>
      <div class="flex shrink-0 flex-col gap-1">
        <For each={banners()}>
          {(banner) => (
            <div class="cloud-announcement">
              <NoticeCard tone={banner.tone} title={banner.title}>
                <MarkdownView
                  trustedHtml={banner.bodyHtml}
                  headingScale="compact"
                  class="-mx-2 max-h-36 overflow-y-auto overscroll-contain pl-2 pr-3 [&_p]:my-0"
                />
              </NoticeCard>
              <IconButton size="sm" label={t().dismissBanner} onClick={() => dismissBanner(banner.version)}>
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
