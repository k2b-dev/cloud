import { prompts } from "@k2b/ui";
import { apiClient } from "../api/client";
import { uploadRequestFailure, uploadResponseFailure } from "../upload-transfer";
import { useBrowserMessages } from "./browser-messages";
import { useFilesMessages } from "./messages";
import { uploadFailureReason, useUploadMessages } from "./upload-messages";
import { createUploadQueue, type UploadQueue } from "./upload-queue";
import { requestSignal, UploadConflict, uploadFile } from "./uploads";

export type ReplacePolicy = "ask" | "overwrite" | "skip";
/** One pick or drop into one storage folder. Its replace answer is given once and then holds for all of its files. */
export type FilesUploadGroup = {
  baseId: string;
  root: string;
  /** Folders to recreate below the root before the first file, parents first. */
  folders: readonly string[];
  policy: ReplacePolicy;
  total: number;
};
export type FilesUploads = UploadQueue<FilesUploadGroup>;

/** Asks once whether existing names are replaced; null when the question was dismissed or its signal aborted. */
export async function askReplace(
  b: ReturnType<ReturnType<typeof useBrowserMessages>>,
  name: string,
  count: number,
  total: number,
  signal: AbortSignal,
): Promise<Exclude<ReplacePolicy, "ask"> | null> {
  const choice = await prompts.confirm(count > 1 ? b.replaceManyQuestion({ count, total }) : b.replaceQuestion(name), {
    title: count > 1 ? b.replaceManyTitle : b.replaceTitle,
    confirmText: b.replaceAll,
    cancelText: total > count ? b.onlyNew(total - count) : b.skip,
    variant: "danger",
    signal,
  });
  return choice === undefined ? null : choice ? "overwrite" : "skip";
}

/** The upload queue of the Files workspace: Cloud authorizes each file, the bytes go straight to Filegate. */
export function createFilesUploads(): FilesUploads {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const u = useUploadMessages();
  return createUploadQueue<FilesUploadGroup>({
    prepare: async (group, signal) => {
      for (const folder of group.folders) {
        const response = await apiClient.bases[":baseId"].directories
          .$post(
            { param: { baseId: group.baseId }, json: { path: group.root ? `${group.root}/${folder}` : folder } },
            { init: { signal: requestSignal(signal) } },
          )
          .catch((error) => {
            throw uploadRequestFailure(error, t().unavailable, signal);
          });
        if (!response.ok && (response.status as number) !== 409) throw await uploadResponseFailure(response, t().unavailable);
      }
    },
    upload: async (group, item, { signal, onProgress, alive }) => {
      const path = group.root ? `${group.root}/${item.path}` : item.path;
      let onConflict: "error" | "overwrite" = group.policy === "overwrite" ? "overwrite" : "error";
      for (;;) {
        try {
          const result = await uploadFile(group.baseId, path, item.file, {
            onConflict,
            signal,
            fallback: u().failed,
            onProgress,
            onStarted: alive,
          });
          return { status: "uploaded", path: result.entry.path };
        } catch (error) {
          if (!(error instanceof UploadConflict) || onConflict !== "error") throw error;
          if (group.policy === "ask") {
            // A cancel or the workspace leaving closes the question with the upload.
            const decided = await askReplace(b(), error.fileName, 1, group.total, signal);
            signal.throwIfAborted();
            if (!decided) return { status: "cancel" };
            group.policy = decided;
          }
          if (group.policy === "skip") return { status: "skipped" };
          onConflict = "overwrite";
        }
      }
    },
    reason: (error) => uploadFailureReason(error, u()),
  });
}
