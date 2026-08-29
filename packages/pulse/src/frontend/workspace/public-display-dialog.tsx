import { Button, prompts, SegmentedControl, toast } from "@k2b/ui";
import { clipboard } from "@k2b/stdlib/browser";
import { createSignal } from "solid-js";
import { usePulseMessages } from "../use-messages";

export type PublicDashboardDisplayTheme = "light" | "dark";
export type PublicDashboardDisplayHeight = "scroll" | "full";

type PublicDashboardDisplayOptions = {
  theme?: PublicDashboardDisplayTheme;
  height?: PublicDashboardDisplayHeight;
};

type OpenPublicDashboardDisplayDialogOptions = {
  resolveLink: (options: PublicDashboardDisplayOptions) => Promise<string>;
};

export const openPublicDashboardDisplayDialog = async (options: OpenPublicDashboardDisplayDialogOptions) => {
  const t = usePulseMessages();
  try {
    await prompts.dialog<void>(
      (close) => {
        const [theme, setTheme] = createSignal<PublicDashboardDisplayTheme>("dark");
        const [height, setHeight] = createSignal<PublicDashboardDisplayHeight>("scroll");
        const [busy, setBusy] = createSignal<"copy" | "open" | null>(null);

        const resolveLink = () => options.resolveLink({ theme: theme(), height: height() });

        const copyLink = async () => {
          setBusy("copy");
          try {
            await clipboard.copy(await resolveLink());
            toast.success(t().publicDisplayLinkCopied);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t().publicDisplayLinkCopyFailed);
          } finally {
            setBusy(null);
          }
        };

        const openLink = async () => {
          setBusy("open");
          try {
            window.open(await resolveLink(), "_blank", "noopener,noreferrer");
            close();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t().publicDisplayOpenFailed);
          } finally {
            setBusy(null);
          }
        };

        return (
          <div class="flex w-full min-w-0 max-w-xl flex-col gap-4 overflow-hidden">
            <p class="max-w-full text-sm leading-relaxed text-dimmed">
              {t().publicDisplayDescription}
            </p>

            <div class="flex min-w-0 flex-col gap-2">
              <p class="text-sm font-medium text-primary">{t().theme}</p>
              <SegmentedControl<PublicDashboardDisplayTheme>
                value={theme}
                onValueChange={setTheme}
                options={[
                  { value: "light", label: t().light, icon: "ti ti-sun" },
                  { value: "dark", label: t().dark, icon: "ti ti-moon" },
                ]}
              />
            </div>

            <div class="flex min-w-0 flex-col gap-2">
              <p class="text-sm font-medium text-primary">{t().pageHeight}</p>
              <SegmentedControl<PublicDashboardDisplayHeight>
                value={height}
                onValueChange={setHeight}
                options={[
                  { value: "scroll", label: t().scrollable, icon: "ti ti-arrows-vertical" },
                  { value: "full", label: t().fullHeight, icon: "ti ti-device-tv" },
                ]}
              />
              <p class="text-xs leading-relaxed text-dimmed">
                {t().fullHeightDescription}
              </p>
            </div>

            <div class="flex flex-wrap justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" size="sm" disabled={busy() !== null} onClick={copyLink}>
                <i class={`ti ${busy() === "copy" ? "ti-loader-2 animate-spin" : "ti-copy"}`} />
                {t().copyLink}
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={busy() !== null} onClick={openLink}>
                <i class={`ti ${busy() === "open" ? "ti-loader-2 animate-spin" : "ti-external-link"}`} />
                {t().openDisplay}
              </Button>
            </div>
          </div>
        );
      },
      { title: t().publicDisplay, icon: "ti ti-device-tv" },
    );
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t().publicDisplayOptionsFailed);
  }
};
