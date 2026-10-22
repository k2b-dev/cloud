import { Button, ButtonLink, Select, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import type { AiMap } from "../map-contracts";
import { mapMessages } from "./map-messages";

const notebooks = z.array(z.object({ id: z.string(), name: z.string() }));
const note = z.object({ id: z.string(), notebookId: z.string() });
export function MapNotebookSave(props: { map: AiMap; onCancel: () => void }) {
  const locale = useLocale();
  const t = () => mapMessages(locale());
  const [selected, setSelected] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [saved, setSaved] = createSignal<string>();
  const [uncertain, setUncertain] = createSignal(false);
  const controller = new AbortController();
  const storageKey = () => `cloud.ai.map-save:${props.map.id}:${props.map.revision}`;
  const remember = (value: unknown) => {
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify(value));
    } catch {
      /* The stable request key also protects a repeated browser submission. */
    }
  };
  const forget = () => {
    try {
      sessionStorage.removeItem(storageKey());
    } catch {
      /* No provider work here. */
    }
  };
  onMount(() => {
    try {
      const saved = z
        .object({ status: z.enum(["pending", "unknown", "saved"]), notebookId: z.string(), href: z.string().optional() })
        .safeParse(JSON.parse(sessionStorage.getItem(storageKey()) ?? "null"));
      if (!saved.success) return;
      setSelected(saved.data.notebookId);
      if (saved.data.status === "saved" && saved.data.href) setSaved(saved.data.href);
      else {
        setUncertain(true);
        setError(t().unknownSave);
      }
    } catch {
      /* Storage may be disabled. */
    }
  });
  onCleanup(() => controller.abort());
  const save = async () => {
    if (!selected() || busy() || uncertain()) return;
    setBusy(true);
    setError("");
    let dispatched = false;
    let rejected = false;
    try {
      const response = await fetch(`/api/ai/conversations/${encodeURIComponent(props.map.conversationId)}/maps/${props.map.id}/export`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(t().failed);
      const snapshot = z.object({ content: z.string(), revision: z.number() }).parse(await response.json());
      if (snapshot.revision !== props.map.revision) throw new Error(t().conflict);
      const key = `assistant-map:${props.map.id}:${props.map.revision}:${selected()}`;
      remember({ status: "pending", notebookId: selected() });
      dispatched = true;
      const result = await invokeCapabilityWithDataSchema(
        {
          kind: "action",
          appId: "notebooks",
          capabilityId: "note.create",
          input: { notebookId: selected(), content: snapshot.content },
          idempotencyKey: key,
          signal: controller.signal,
        },
        note,
      );
      if (!result.ok) {
        if (result.error.status >= 500 || result.error.code === "CAPABILITY_UNAVAILABLE") {
          setUncertain(true);
          throw new Error(t().unknownSave);
        }
        rejected = true;
        throw new Error(result.error.message);
      }
      const link = result.data.links?.find((l) => l.rel === "open");
      const href = link?.href ?? `/app/notebooks/${result.data.data.notebookId}/notes/${result.data.data.id}`;
      setSaved(href);
      remember({ status: "saved", notebookId: selected(), href });
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (dispatched && !rejected) {
        setUncertain(true);
        remember({ status: "unknown", notebookId: selected() });
        setError(t().unknownSave);
        return;
      }
      if (rejected) forget();
      setError(cause instanceof Error ? cause.message : t().unknownSave);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="ai-map__save">
      <Show
        when={!saved()}
        fallback={
          <ButtonLink href={saved()!} variant="ghost">
            {t().saved}
          </ButtonLink>
        }
      >
        <Select
          label={t().notebook}
          value={selected()}
          onValueChange={setSelected}
          disabled={busy() || uncertain()}
          loadOptions={async (query, signal) => {
            const result = await invokeCapabilityWithDataSchema(
              {
                kind: "query",
                appId: "notebooks",
                capabilityId: "notebook.list",
                input: { query, minimumPermission: "write", limit: 100 },
                signal,
              },
              notebooks,
            );
            if (!result.ok) throw new Error(result.error.message);
            return result.data.data.map((n) => ({ value: n.id, label: n.name }));
          }}
        />
        <div class="ai-map__actions">
          <Button size="sm" disabled={!selected() || busy() || uncertain()} onClick={() => void save()}>
            {busy() ? t().pending : t().save}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy()} onClick={props.onCancel}>
            {t().cancel}
          </Button>
        </div>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={uncertain() && selected()}>
        <ButtonLink size="sm" variant="ghost" href={`/app/notebooks/${selected()}`}>
          {t().inspectNotebook}
        </ButtonLink>
      </Show>
    </div>
  );
}
