import { clipboard } from "@k2b/stdlib/browser";
import { Button, prompts, SegmentedControl, Switch, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import { venueMessages } from "../../../messages";
import { buildPublicVenueUrl, VENUE_PUBLIC_REFRESH_SECONDS, type VenuePublicDisplayHeight } from "../../public-runtime";

export const openVenuePublicDisplayDialog = async (venueId: string, locale: string): Promise<void> => {
  const { t } = venueMessages.resolve([locale]);
  try {
    await prompts.dialog<void>(
      (close) => {
        const [height, setHeight] = createSignal<VenuePublicDisplayHeight>("scroll");
        const [refresh, setRefresh] = createSignal(false);
        const [busy, setBusy] = createSignal<"copy" | "open" | null>(null);
        const resolveLink = () => buildPublicVenueUrl(window.location.origin, venueId, { height: height(), refresh: refresh() });
        const setLayout = (value: VenuePublicDisplayHeight) => {
          setHeight(value);
          if (value === "full") setRefresh(true);
        };

        const copyLink = async () => {
          setBusy("copy");
          try {
            await clipboard.copy(resolveLink());
            toast.success(t.publicPageLinkCopied);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t.copyPublicPageFailed);
          } finally {
            setBusy(null);
          }
        };

        const openLink = () => {
          setBusy("open");
          try {
            window.open(resolveLink(), "_blank", "noopener,noreferrer");
            close();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t.openPublicPageFailed);
          } finally {
            setBusy(null);
          }
        };

        return (
          <div class="flex w-full min-w-0 max-w-xl flex-col gap-4 overflow-hidden">
            <p class="text-sm leading-relaxed text-dimmed">{t.displayIntro}</p>
            <div class="flex min-w-0 flex-col gap-2">
              <p class="text-sm font-medium text-primary">{t.pageLayout}</p>
              <SegmentedControl<VenuePublicDisplayHeight>
                value={height}
                onValueChange={setLayout}
                options={[
                  { value: "scroll", label: t.scrollablePage, icon: "ti ti-arrows-vertical" },
                  { value: "full", label: t.fullDisplay, icon: "ti ti-device-tv" },
                ]}
              />
              <p class="text-xs leading-relaxed text-dimmed">{t.fullDisplayDescription}</p>
            </div>
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="text-sm font-medium text-primary">{t.liveUpdates}</p>
                <p class="text-xs leading-relaxed text-dimmed">{t.liveUpdatesDescription({ seconds: VENUE_PUBLIC_REFRESH_SECONDS })}</p>
              </div>
              <Switch label={t.autoRefresh} value={refresh} onValueChange={setRefresh} />
            </div>
            <div class="flex flex-wrap justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" size="sm" disabled={busy() !== null} onClick={copyLink}>
                <i class={`ti ${busy() === "copy" ? "ti-loader-2 animate-spin" : "ti-copy"}`} />
                {t.copyLink}
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={busy() !== null} onClick={openLink}>
                <i class={`ti ${busy() === "open" ? "ti-loader-2 animate-spin" : "ti-external-link"}`} />
                {t.openPage}
              </Button>
            </div>
          </div>
        );
      },
      { title: t.publicPage, icon: "ti ti-device-tv" },
    );
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t.openPageOptionsFailed);
  }
};
