import { coreClient } from "@k2b/cloud/clients/core";
import { useLocale } from "@k2b/ui";
import { Band, Check, Notice, Text } from "@k2b/ui/v2";
import { createSignal, onCleanup, Show } from "solid-js";
import { browserMessages } from "./messages";

/**
 * "Collect Web Vitals": the switch writes the core setting, then reads it back; the state shows only what the server
 * confirmed. A failed or unclear save says so with a retry. Leaving the page aborts a save that still runs.
 */
export default function CollectionSwitch(props: { enabled: boolean | null }) {
  const locale = useLocale();
  const t = () => browserMessages.resolve([locale()]).t;
  const [enabled, setEnabled] = createSignal(props.enabled);
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let controller: AbortController | undefined;
  let requested = false;
  onCleanup(() => controller?.abort());
  const save = async (value: boolean) => {
    if (pending()) return;
    requested = value;
    controller = new AbortController();
    const signal = controller.signal;
    setPending(true);
    setFailed(false);
    try {
      const response = await coreClient.admin.core.settings.$put(
        { json: { updates: { "observability.web_vitals.enabled": value } } },
        { init: { signal } },
      );
      if (!response.ok) throw new Error("save");
      const confirmed = await coreClient.admin.core.settings["web-vitals"].$get({}, { init: { signal } });
      if (!confirmed.ok) throw new Error("read");
      const state = await confirmed.json();
      setEnabled(state.enabled);
      if (state.enabled !== value) throw new Error("mismatch");
    } catch {
      if (!signal.aborted) {
        setFailed(true);
        setEnabled(null);
      }
    } finally {
      if (!signal.aborted) setPending(false);
    }
  };
  return (
    <>
      <Band>
        <Check switch label={t().collect} checked={enabled() === true} disabled={pending()} onChange={(value) => void save(value)} />
        <Text type="meta" muted>
          {enabled() === null ? t().unknown : enabled() ? t().active : t().inactive} · {t().costs}
        </Text>
        <Show when={enabled() === false}>
          <Text type="meta" muted>
            {t().history}
          </Text>
        </Show>
      </Band>
      <Show when={failed()}>
        <Notice
          tone="bad"
          title={t().saveError}
          actions={[{ label: t().retry, icon: "refresh", disabled: pending(), onClick: () => void save(requested) }]}
        >
          {t().unknown}
        </Notice>
      </Show>
    </>
  );
}
