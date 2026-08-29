import { Button, dialogCore, MarkdownView, PanelDialog, panelDialogOptions, useLocale } from "@k2b/ui";
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

const toneClass = (tone: AnnouncementDisplayEntry["tone"]) => {
  if (tone === "success")
    return "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100";
  if (tone === "warning")
    return "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100";
  if (tone === "danger") return "border-red-200 bg-red-50 text-red-950 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100";
  return "border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100";
};

const toneIcon = (tone: AnnouncementDisplayEntry["tone"]) => {
  if (tone === "success") return "ti ti-circle-check";
  if (tone === "warning") return "ti ti-alert-triangle";
  if (tone === "danger") return "ti ti-alert-circle";
  return "ti ti-info-circle";
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
            <section
              class={`flex max-h-[min(40vh,14rem)] items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-sm ${toneClass(banner.tone)}`}
            >
              <i class={`${toneIcon(banner.tone)} mt-0.5 shrink-0`} />
              <div class="min-h-0 min-w-0 flex-1">
                <p class="font-semibold">{banner.title}</p>
                <MarkdownView
                  trustedHtml={banner.bodyHtml}
                  headingScale="compact"
                  class="mt-1 max-h-36 overflow-y-auto overscroll-contain pr-1 [&_p]:my-0"
                />
              </div>
              <button
                type="button"
                class="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                aria-label={t().dismissBanner}
                onClick={() => dismissBanner(banner.version)}
              >
                <i class="ti ti-x" />
              </button>
            </section>
          )}
        </For>
      </div>
    </Show>
  );
}
