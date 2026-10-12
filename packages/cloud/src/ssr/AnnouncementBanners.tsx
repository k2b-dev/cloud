import { IconButton, MarkdownView, NoticeCard, useLocale } from "@k2b/ui";
import { For } from "solid-js";
import type { AnnouncementDisplayEntry } from "../contracts/announcements";
import { platformMessages } from "./platform-messages";

export default function AnnouncementBanners(props: { banners: AnnouncementDisplayEntry[] }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  if (props.banners.length === 0) return null;
  return (
    <div class="flex shrink-0 flex-col gap-1">
      <For each={props.banners}>
        {(banner) => (
          <div class="cloud-announcement">
            <NoticeCard tone={banner.tone} title={banner.title}>
              <MarkdownView
                trustedHtml={banner.bodyHtml}
                headingScale="compact"
                class="-mx-2 max-h-36 overflow-y-auto overscroll-contain pl-2 pr-3 [&_p]:my-0"
              />
            </NoticeCard>
            <IconButton size="sm" label={t().dismissBanner} data-cloud-announcement-dismiss={banner.version}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </For>
    </div>
  );
}
