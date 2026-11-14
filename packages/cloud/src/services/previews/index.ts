import { ObjectStoreConfigurationError, objectStoreBackend } from "../../_internal/object-store-config";
import { getProcessApplicationPackage } from "../../_internal/process-identity";
import { DEFAULT_STORAGE_BUCKET_ID } from "../../contracts/storage-buckets";
import { sql } from "../../runtime/clients";
import type { PreviewVariant } from "../../shared/previews";
import { storage } from "../object-store";
import { generatePreview } from "./generate";
import { createPreviewsService } from "./service";
import { createPreviewsStore } from "./store";
import type { PreviewReader, PreviewSource } from "./types";

let service: ReturnType<typeof createPreviewsService> | undefined;
let registeredReader: PreviewReader | undefined;
let submit: (source: PreviewSource, priority: "high" | "low") => Promise<void> = async () => {
  throw new Error("Preview runtime is not started");
};
export function previewService() {
  const packageName = getProcessApplicationPackage();
  if (!packageName) throw new Error("Start the application before using previews");
  if (!service) {
    service = createPreviewsService({
      store: createPreviewsStore(sql, packageName),
      async persistent() {
        try {
          await objectStoreBackend(DEFAULT_STORAGE_BUCKET_ID);
          return true;
        } catch (error) {
          if (error instanceof ObjectStoreConfigurationError && error.code === "storage_not_configured") return false;
          throw error;
        }
      },
      object: (key) => storage.file(key),
      submit: (source, priority) => submit(source, priority),
      generate: generatePreview,
    });
    if (registeredReader) service.reader(registeredReader);
  }
  return service;
}
/** Only an application that reads its own sources generates previews; the others start no queues or workers. */
export const hasPreviewReader = () => registeredReader !== undefined;
export function setPreviewSubmit(value: typeof submit) {
  submit = value;
}
export const previews = {
  reader(value: PreviewReader): void {
    if (registeredReader) throw new Error("A preview reader is already registered");
    registeredReader = value;
    service?.reader(value);
  },
  read: (source: PreviewSource, variant: PreviewVariant, options: { signal?: AbortSignal } = {}) =>
    previewService().read(source, variant, options),
  enqueue: (source: PreviewSource) => previewService().enqueue(source),
  retry: (source: PreviewSource) => previewService().retry(source),
  discard: (key: string) => previewService().discard(key),
};
export type { PreviewVariant } from "../../shared/previews";
export type { PreviewReader, PreviewReadResult, PreviewSource } from "./types";
export { PreviewSourceChanged } from "./types";
