import { invokeCapability, listCapabilityCatalog } from "@k2b/cloud/capabilities";
import { cloudResourceRefAppId, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import { Button, prompts, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { ResourceValueSchema } from "../../../field-types/resource";
import { gridsFormMessages } from "../forms/messages";

export default function ResourceValue(props: { value: unknown }) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const value = () => {
    const parsed = ResourceValueSchema.safeParse(props.value);
    return parsed.success ? parsed.data : null;
  };
  const open = async () => {
    const ref = value();
    if (!ref || busy()) return;
    setBusy(true);
    try {
      const appId = cloudResourceRefAppId(ref);
      let cursor: string | undefined;
      do {
        const catalog = await listCapabilityCatalog({ cursor, limit: 25 });
        if (!catalog.ok) throw new Error(t().resourceUnavailable);
        const app = catalog.data.apps.find((item) => item.appId === appId);
        if (app) {
          const reader = resolveCapabilityResourceReader(app.manifest, ref);
          if (!reader) break;
          const result = await invokeCapability({ appId, capabilityId: reader.localId, kind: "query", input: { id: ref.id } });
          if (!result.ok) break;
          const href = result.data.links?.find((link) => link.rel === "open")?.href;
          if (!href) break;
          // The canonical reader supplies a validated same-origin Cloud path.
          window.location.assign(href);
          return;
        }
        cursor = catalog.data.page.hasMore ? catalog.data.page.nextCursor : undefined;
      } while (cursor);
      throw new Error(t().resourceUnavailable);
    } catch {
      void prompts.error(t().resourceUnavailable);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={value()} fallback="—">
      {(ref) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy()}
          onClick={(event) => {
            event.stopPropagation();
            void open();
          }}
        >
          <i class={busy() ? "ti ti-loader-2 animate-spin" : "ti ti-external-link"} />
          {ref().title ?? `${ref().type} · ${ref().id}`}
        </Button>
      )}
    </Show>
  );
}
