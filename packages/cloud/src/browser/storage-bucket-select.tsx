import { i18n } from "@k2b/stdlib";
import { InlineGuidance, Select, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import { parseStorageBucketId, type StorageBucketId, type StorageBucketSummary } from "../contracts/storage-buckets";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      defaultName: "Default",
      disconnected: "disconnected",
      unknown: "Unknown bucket",
      disconnectedHint:
        "An administrator removed this bucket. The app's files there cannot be reached until it is restored in Administration › Storage. Choose another bucket or ask for it to be restored.",
      unknownHint: "This Cloud has no bucket with this ID. Choose a bucket from the list.",
    },
    de: {
      defaultName: "Standard",
      disconnected: "getrennt",
      unknown: "Unbekannter Bucket",
      disconnectedHint:
        "Ein Admin hat diesen Bucket entfernt. Die Dateien der App dort sind nicht erreichbar, bis er unter Administration › Speicher wiederhergestellt ist. Wähle einen anderen Bucket oder bitte um die Wiederherstellung.",
      unknownHint: "Diese Cloud hat keinen Bucket mit dieser ID. Wähle einen Bucket aus der Liste.",
    },
  },
});

export type StorageBucketSelectProps = {
  /** The stored bucket ID, as the setting holds it. */
  value: string | null | undefined;
  /** `SettingEntry.storageBuckets` of the setting, or the result of `storage.buckets()`. */
  buckets: readonly StorageBucketSummary[];
  onValueChange: (id: StorageBucketId) => void;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  disabled?: boolean;
  error?: string;
};

/**
 * Chooses the bucket a `storage_bucket` setting points to. It saves the bucket's ID and shows its current name, so a
 * renamed bucket keeps its place. A stored ID of a removed or unknown bucket stays visible with a hint instead of
 * silently switching to another bucket.
 */
export function StorageBucketSelect(props: StorageBucketSelectProps) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  const label = (bucket: StorageBucketSummary) => (bucket.isDefault ? t().defaultName : bucket.name);
  const current = createMemo(
    (): { bucket: StorageBucketSummary | undefined; state: "empty" | "unknown" | "connected" | "disconnected" } => {
      const id = parseStorageBucketId(props.value);
      const bucket = id ? props.buckets.find((item) => item.id === id) : undefined;
      return { bucket, state: !props.value ? "empty" : !bucket ? "unknown" : bucket.connected ? "connected" : "disconnected" };
    },
  );
  const options = () => {
    const connected = props.buckets.filter((bucket) => bucket.connected).map((bucket) => ({ value: bucket.id, label: label(bucket) }));
    const now = current();
    // The stored choice stays visible, also when it can no longer be chosen again.
    if (now.state === "disconnected" && now.bucket)
      return [...connected, { value: now.bucket.id, label: `${now.bucket.name} (${t().disconnected})`, disabled: true }];
    if (now.state === "unknown" && props.value)
      return [...connected, { value: props.value, label: t().unknown, description: props.value, disabled: true }];
    return connected;
  };
  return (
    <div class="flex flex-col gap-2" data-storage-bucket-select={current().state}>
      <Select
        id={props.id}
        aria-label={props["aria-label"]}
        aria-describedby={props["aria-describedby"]}
        icon="ti ti-database"
        value={() => props.value ?? null}
        options={options()}
        disabled={props.disabled}
        error={() => props.error}
        onValueChange={(value) => {
          const id = parseStorageBucketId(value);
          if (id) props.onValueChange(id);
        }}
      />
      <Show when={current().state === "disconnected"}>
        <InlineGuidance tone="warning" icon="ti ti-plug-connected-x">
          {t().disconnectedHint}
        </InlineGuidance>
      </Show>
      <Show when={current().state === "unknown"}>
        <InlineGuidance tone="warning" icon="ti ti-database-off">
          {t().unknownHint}
        </InlineGuidance>
      </Show>
    </div>
  );
}
