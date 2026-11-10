import type { AdminStorageBucket } from "@k2b/cloud/contracts/storage-buckets";
import { InlineGuidance, NoticeCard, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { readBucket, storageAdminApi } from "./client";
import { setStorageDetailControls } from "./detail-controls";
import { storageAreaMessages } from "./messages";
import { StorageCheckNotice, StorageUsage } from "./parts";

/**
 * The default bucket's parts around its settings form: `status` shows the last test above the form and runs the test
 * from the head; `usage` lists the app areas with data below it. The form itself saves through the storage settings.
 */
export default function StorageDefaultDetail(props: { part: "status" | "usage"; bucket: AdminStorageBucket }) {
  const locale = useLocale();
  const t = () => storageAreaMessages.resolve([locale()]).t;
  const [bucket, setBucket] = createSignal(props.bucket);
  const [testing, setTesting] = createSignal(false);
  const [error, setError] = createSignal("");

  if (props.part === "status") {
    // Testing updates the notice in place, so an unsaved draft in the form beside it stays as it is.
    const test = async () => {
      setTesting(true);
      setError("");
      try {
        const tested = await readBucket(await storageAdminApi.buckets[":id"].test.$post({ param: { id: bucket().id } }), t().testFailed);
        setBucket(tested);
        if (tested.check.state === "ok") toast.success(t().testOk);
      } catch (failure) {
        setError(failure instanceof Error && failure.message ? failure.message : t().testFailed);
      } finally {
        setTesting(false);
      }
    };
    createEffect(() => setStorageDetailControls({ test: { busy: testing(), run: () => void test() } }));
    onCleanup(() => setStorageDetailControls(null));
  }

  return (
    <Show
      when={props.part === "status"}
      fallback={
        <div class="flex flex-col gap-4 pb-8">
          <StorageUsage t={t()} id={bucket().id} />
          <InlineGuidance tone="neutral" icon="ti ti-database-export">
            {t().backup}
          </InlineGuidance>
        </div>
      }
    >
      <div class="flex flex-col gap-3" data-storage-detail="default">
        <StorageCheckNotice t={t()} bucket={bucket()} />
        <Show when={error()}>
          <NoticeCard tone="danger" role="alert" title={t().testFailed} detail={error()} />
        </Show>
      </div>
    </Show>
  );
}
