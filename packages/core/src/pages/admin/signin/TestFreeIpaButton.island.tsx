import { coreClient } from "@k2b/cloud/clients/core";
import { settingsSaveControls } from "@k2b/cloud/ssr/settings-draft";
import { Button, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { settingsMessages } from "../settings/_components/messages";

/** Tests the saved FreeIPA connection; while the form has unsaved changes, it waits for Save. */
export default function TestFreeIpaButton() {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const pending = () => (settingsSaveControls()?.state ?? "saved") !== "saved";
  const run = async () => {
    setBusy(true);
    try {
      const response = await coreClient.admin.core.settings["test-freeipa"].$post();
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? t().freeIpaTestFailed({ status: response.status }));
      toast.success(t().freeIpaReachable);
    } catch (error) {
      void prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip.Anchor content={pending() ? t().testFreeIpaPending : t().testFreeIpaSaved}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={busy()}
        loadingLabel={t().testingConnection}
        disabled={pending()}
        onClick={() => void run()}
      >
        <i class="ti ti-plug-connected" aria-hidden="true" /> {t().testConnection}
      </Button>
    </Tooltip.Anchor>
  );
}
