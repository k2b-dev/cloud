import { Button } from "@k2b/ui";
import { setRefreshed, setRetrying } from "./provider-state";

/**
 * "Try again" for providers that did not answer: asks Core for the app's numbers once more and refreshes the values in
 * place. If they still do not answer, the values say "Not available" again and the button stays.
 */
export default function ProviderRetry(props: { app: string; label: string }) {
  let busy = false;
  const retry = async () => {
    if (busy) return;
    busy = true;
    setRetrying(true);
    try {
      const response = await fetch(`/api/admin/apps/${encodeURIComponent(props.app)}/status?window=24h`, { credentials: "same-origin" });
      const body = response.ok
        ? ((await response.json()) as { traffic: string | null; errors: string | null; errorsTone?: "danger"; unavailable: boolean })
        : null;
      setRefreshed(body ?? { traffic: null, errors: null, unavailable: true });
    } catch {
      setRefreshed({ traffic: null, errors: null, unavailable: true });
    } finally {
      busy = false;
      setRetrying(false);
    }
  };
  return (
    <Button size="sm" variant="secondary" onClick={() => void retry()}>
      <i class="ti ti-refresh" aria-hidden="true" />
      {props.label}
    </Button>
  );
}
