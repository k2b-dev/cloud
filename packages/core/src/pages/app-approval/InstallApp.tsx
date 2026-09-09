import { qr } from "@k2b/stdlib/qr";
import { Button, dialogCore, PanelDialog, panelDialogOptions, toast, useLocale } from "@k2b/ui";
import { onCleanup } from "solid-js";
import { appApprovalMessages } from "./messages";

export default function InstallApp(props: { origin: string }) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  let closeDialog: (() => void) | undefined;
  onCleanup(() => closeDialog?.());
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.origin);
      toast.success(t().copied);
    } catch {
      toast.error(t().failure);
    }
  };
  const open = () => {
    const mobile =
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (mobile) {
      window.open(props.origin, "_blank", "noopener,noreferrer");
      return;
    }
    if (closeDialog) return;
    void dialogCore
      .open<void>(
        (close) => {
          closeDialog = close;
          return (
            <PanelDialog>
              <PanelDialog.Header title={t().install} icon="ti ti-device-mobile" close={close} />
              <PanelDialog.Body>
                <div class="flex flex-col items-center gap-4">
                  <p class="text-sm text-dimmed">{t().installHint}</p>
                  <img
                    class="w-64 max-w-full"
                    alt={t().installQr}
                    src={`data:image/svg+xml,${encodeURIComponent(qr.toSvg(props.origin))}`}
                  />
                  <p class="break-all text-sm text-dimmed">{props.origin}</p>
                  <Button variant="secondary" onClick={copy}>
                    {t().copyInstallLink}
                  </Button>
                </div>
              </PanelDialog.Body>
            </PanelDialog>
          );
        },
        { ...panelDialogOptions, panelClassName: `${panelDialogOptions.panelClassName} app-pairing-dialog` },
      )
      .then(() => {
        closeDialog = undefined;
      });
  };
  return (
    <Button variant="secondary" size="sm" onClick={open}>
      {t().install}
    </Button>
  );
}
