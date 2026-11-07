import { coreClient } from "@k2b/cloud/clients/core";
import { formatBytes } from "@k2b/cloud/shared";
import { settingsSaveControls } from "@k2b/cloud/ssr/settings-draft";
import { Button, prompts, Tooltip, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { settingsMessages } from "../settings/_components/messages";

/** Renders a test PDF with the saved settings; while the form has unsaved changes, it waits for Save. */
export default function TestPdfButton() {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const pending = () => (settingsSaveControls()?.state ?? "saved") !== "saved";
  const run = async () => {
    setBusy(true);
    try {
      const response = await coreClient.admin.core.settings["test-pdf"].$post();
      const body = (await response.json().catch(() => null)) as { message?: string; bytes?: number; contentType?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? t().pdfTestFailed({ status: response.status }));
      void prompts.alert(t().pdfResponse({ size: formatBytes(body?.bytes ?? 0, { locale: locale() }), type: body?.contentType ?? "" }));
    } catch (error) {
      void prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip.Anchor content={pending() ? t().testPdfPending : t().testPdfSaved}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={busy()}
        loadingLabel={t().testingRenderer}
        disabled={pending()}
        onClick={() => void run()}
      >
        <i class="ti ti-file-type-pdf" aria-hidden="true" /> {t().testRenderer}
      </Button>
    </Tooltip.Anchor>
  );
}
