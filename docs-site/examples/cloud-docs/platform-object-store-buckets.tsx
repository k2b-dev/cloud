import { defineApp, parseStorageBucketId, type StorageBucketId, type StorageBucketSummary, storage } from "@k2b/cloud";
import { StorageBucketSelect } from "@k2b/cloud/browser/storage-bucket-select";
import { createSignal } from "solid-js";

export const warenfluss = defineApp({
  id: "warenfluss",
  name: "Warenfluss",
  icon: "ti ti-truck",
  description: "Orders and invoices",
  baseUrl: "http://warenfluss:3000",
  routes: ["/app/warenfluss", "/api/warenfluss"],
  settings: {
    "warenfluss.archive_bucket": {
      kind: "storage_bucket",
      label: "Archive bucket",
      description: "Where invoices are kept for ten years.",
    },
  },
});

/** Call from an authorized application service after app.start(). */
export const archiveInvoice = async (pdfBytes: Uint8Array) => {
  const archive = storage.bucket(await warenfluss.settings.get("warenfluss.archive_bucket"));
  await archive.file("2026/invoice-42.pdf").write(pdfBytes, { type: "application/pdf" });
  const { contents } = await archive.list({ prefix: "2026/" });
  const publicUrl = await archive.public.file("2026/cover.webp").url;
  return { keys: contents?.map((object) => object.key) ?? [], publicUrl };
};

/** An ID stored elsewhere is parsed, never cast. */
export const copyToArchive = async (storedId: string, key: string) => {
  const id = parseStorageBucketId(storedId);
  if (!id) throw new Error("Not a storage bucket ID.");
  await storage
    .bucket(id)
    .file(key)
    .write(await storage.file(key).bytes());
};

export const listBuckets = (): Promise<StorageBucketSummary[]> => storage.buckets();

/** The administration form renders a storage_bucket setting with the shared select. */
export const ArchiveBucketField = (props: { initial: StorageBucketId; buckets: StorageBucketSummary[] }) => {
  const [value, setValue] = createSignal<StorageBucketId>(props.initial);
  return <StorageBucketSelect aria-label="Archive bucket" value={value()} buckets={props.buckets} onValueChange={setValue} />;
};
