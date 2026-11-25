import { qr } from "@k2b/stdlib/qr";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Canvas, Dialog, Facts, Text, useToast } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import { appApprovalMessages } from "./messages";

/** The configured sign-in app address as a QR code with a copy action. */
export function InstallLink(props: { origin: string }) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.origin);
      toast(t().installLinkCopied, { status: "ok" });
    } catch {
      toast(t().failure, { status: "bad" });
    }
  };
  return (
    <>
      {/* k2b-ui gap: no primitive shows a QR code; it is a drawing in a Canvas. */}
      <Band>
        <Canvas label={t().installQr} height={256}>
          <img
            alt={t().installQr}
            width="256"
            height="256"
            style={{ display: "block", margin: "0 auto", "max-width": "100%", height: "100%" }}
            src={`data:image/svg+xml,${encodeURIComponent(qr.toSvg(props.origin))}`}
          />
        </Canvas>
      </Band>
      <Facts items={[{ label: t().install, value: props.origin, mono: true }]} />
      <Bar
        end={
          <Button icon="copy" onClick={() => void copy()}>
            {t().copyInstallLink}
          </Button>
        }
      />
    </>
  );
}

/** How to get the sign-in app: on a phone its page opens, elsewhere a dialog shows the address as a QR code. */
export const useInstallApp = (origin: () => string) => {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(false);
  const start = () => {
    const mobile =
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (mobile) window.open(origin(), "_blank", "noopener,noreferrer");
    else setOpen(true);
  };
  const dialog = () => (
    <Dialog
      title={t().install}
      open={open()}
      onOpenChange={setOpen}
      foot={
        <Button variant="primary" onClick={() => setOpen(false)}>
          {t().close}
        </Button>
      }
    >
      <Text muted>{t().installHint}</Text>
      <InstallLink origin={origin()} />
    </Dialog>
  );
  return { start, dialog };
};
