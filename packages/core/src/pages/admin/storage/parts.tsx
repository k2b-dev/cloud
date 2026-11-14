import { type AdminStorageBucket, type StorageBucketUsage, StorageBucketUsageSchema } from "@k2b/cloud/contracts/storage-buckets";
import { Button, Format, NoticeCard, SettingsSection, Tag } from "@k2b/ui";
import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { readStorageAdmin, storageAdminApi } from "./client";
import type { StorageAreaMessages } from "./messages";
import { storageStepLabel } from "./presentation";

type UsageState = { state: "loading" } | { state: "failed" } | { state: "ready"; usage: StorageBucketUsage };

/** Reads which app areas have data in a bucket; the answer comes from the bucket itself. */
const loadStorageUsage = async (id: string): Promise<StorageBucketUsage> =>
  readStorageAdmin(await storageAdminApi.buckets[":id"].usage.$get({ param: { id } }), StorageBucketUsageSchema, "usage");

/** The last connection test of a bucket. A failed test names the step; the head offers "Test again". */
export function StorageCheckNotice(props: { t: StorageAreaMessages; bucket: AdminStorageBucket }) {
  return (
    <Switch>
      <Match when={props.bucket.check.state === "ok"}>
        <NoticeCard tone="success" data-storage-check="ok">
          {props.t.okTested} <Format.DateTime value={props.bucket.check.checkedAt ?? undefined} /> {props.t.okDetail}
        </NoticeCard>
      </Match>
      <Match when={props.bucket.check.state === "failed"}>
        <NoticeCard
          tone="danger"
          role="alert"
          data-storage-check="failed"
          title={props.t.failedNotice({ step: storageStepLabel(props.t, props.bucket.check.step) })}
          detail={props.t.failedDetail}
        />
      </Match>
      <Match when={props.bucket.check.state === "untested"}>
        <NoticeCard tone="neutral" data-storage-check="untested" title={props.t.untestedNotice} detail={props.t.untestedDetail} />
      </Match>
    </Switch>
  );
}

/** The app areas with data in the bucket. Loads on open; a bucket that cannot be read says so and offers a retry. */
export function StorageUsage(props: { t: StorageAreaMessages; id: string; onLoaded?: (usage: StorageBucketUsage | null) => void }) {
  const [usage, setUsage] = createSignal<UsageState>({ state: "loading" });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const load = async () => {
    setUsage({ state: "loading" });
    try {
      const result = await loadStorageUsage(props.id);
      if (disposed) return;
      setUsage({ state: "ready", usage: result });
      props.onLoaded?.(result);
    } catch {
      if (disposed) return;
      setUsage({ state: "failed" });
      props.onLoaded?.(null);
    }
  };
  onMount(() => void load());
  const ready = () => {
    const current = usage();
    return current.state === "ready" ? current.usage : null;
  };
  return (
    <SettingsSection title={props.t.usage} subtitle={props.t.usageHelp}>
      {/* One line of room for every state, so the backup note below never jumps. */}
      <div class="flex min-h-8 flex-wrap items-center gap-1.5 text-sm" aria-live="polite" data-storage-usage={usage().state}>
        <Switch>
          <Match when={usage().state === "loading"}>
            <span class="inline-flex items-center gap-2 text-(--k2b-text-muted)">
              <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
              {props.t.usageLoading}
            </span>
          </Match>
          <Match when={usage().state === "failed"}>
            <span class="text-(--k2b-text-muted)">{props.t.usageFailed}</span>
            <Button type="button" variant="text" size="xs" onClick={() => void load()}>
              {props.t.usageRetry}
            </Button>
          </Match>
          <Match when={ready()}>
            {(current) => (
              <Show when={current().packages.length > 0} fallback={<span class="text-(--k2b-text-muted)">{props.t.usageNone}</span>}>
                <For each={current().packages}>{(name) => <Tag size="sm">{name}</Tag>}</For>
                <Show when={current().truncated}>
                  <span class="text-(--k2b-text-muted)">{props.t.usageMore}</span>
                </Show>
              </Show>
            )}
          </Match>
        </Switch>
      </div>
    </SettingsSection>
  );
}
