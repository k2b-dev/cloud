import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { chunks, type UploadState } from "@valentinkolb/filegate/utils";
import { apiClient } from "@/api/client";
import { files } from "@k2b/stdlib/browser";
import type { FileBaseInfo } from "@/contracts";

// =============================================================================
// Types
// =============================================================================

export type UploadStatus = "pending" | "uploading" | "complete" | "error";

export type FileUploadState = {
  id: string;
  filename: string;
  size: number;
  progress: number; // 0-100
  status: UploadStatus;
  error?: string;
  relativePath?: string;
};

export type UploadManagerState = {
  files: FileUploadState[];
  isUploading: boolean;
};

// =============================================================================
// Constants
// =============================================================================

const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB
const MAX_CONCURRENT_FILES = 3;

type UploadStartResponse = {
  uploadId: string;
  uploadTicket: string;
  totalChunks: number;
  chunkSize: number;
  uploadedChunks: number[];
  completed: false;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isUploadStartResponse = (value: unknown): value is UploadStartResponse => {
  if (!isObject(value)) return false;
  return (
    typeof value["uploadId"] === "string" &&
    typeof value["uploadTicket"] === "string" &&
    typeof value["totalChunks"] === "number" &&
    typeof value["chunkSize"] === "number" &&
    Array.isArray(value["uploadedChunks"]) &&
    value["completed"] === false
  );
};

// =============================================================================
// Upload Manager
// =============================================================================

/**
 * Create an upload manager for handling file uploads with progress tracking.
 * Always uses chunked uploads for consistent behavior and progress tracking.
 */
type UploadMessages = {
  emptyFile: string;
  preparationFailed: string;
  startFailed: string;
  chunkFailed: string;
  cancelled: string;
  uploadFailed: string;
  selectFailed: string;
};

export function createUploadManager(messages: () => UploadMessages) {
  const [state, setState] = createStore<UploadManagerState>({
    files: [],
    isUploading: false,
  });

  const [abortController, setAbortController] = createSignal<AbortController | null>(null);

  const updateFile = (id: string, updates: Partial<FileUploadState>) => {
    setState("files", (file) => file.id === id, updates);
  };

  const uploadFile = async (
    file: File,
    id: string,
    baseType: FileBaseInfo["type"],
    baseId: string,
    targetPath: string,
    signal: AbortSignal,
  ): Promise<void> => {
    updateFile(id, { status: "uploading", progress: 0 });

    // Check for empty files
    if (!file.size || file.size <= 0) {
      throw new Error(messages().emptyFile);
    }

    const upload = await chunks.prepare({ file, chunkSize: CHUNK_SIZE });

    // Verify fileSize was set correctly
    if (!upload.fileSize || upload.fileSize <= 0) {
      throw new Error(messages().preparationFailed);
    }

    const unsubscribe = upload.subscribe((s: UploadState) => {
      if (s.status === "error") return;
      updateFile(id, {
        progress: s.percent,
        status: s.status === "completed" ? "complete" : "uploading",
      });
    });

    try {
      const startRes = await apiClient[":baseType"][":baseId"].upload.$post({
        param: { baseType, baseId },
        query: { path: targetPath },
        json: {
          filename: file.name,
          size: upload.fileSize,
          checksum: upload.checksum,
          chunkSize: upload.chunkSize,
        },
      });

      if (!startRes.ok) {
        throw new Error(messages().startFailed);
      }

      const uploadData = await startRes.json();
      if (!isUploadStartResponse(uploadData)) {
        throw new Error(messages().startFailed);
      }
      const { uploadId, uploadTicket } = uploadData;

      await upload.sendAll({
        retries: 3,
        concurrency: 5,
        fn: async ({ index, data }) => {
          if (signal.aborted) throw new Error(messages().cancelled);

          const chunkRes = await fetch(`/api/files/${baseType}/${baseId}/upload/${uploadId}?index=${index}`, {
            method: "PUT",
            headers: {
              "x-chunk-checksum": await upload.hash({ data }),
              "x-upload-ticket": uploadTicket,
            },
            body: data,
            signal,
          });

          if (!chunkRes.ok) {
            throw new Error(messages().chunkFailed);
          }
        },
      });

      updateFile(id, { status: "complete", progress: 100 });
    } finally {
      unsubscribe();
    }
  };

  const startUpload = async (
    mode: "files" | "folder",
    baseType: FileBaseInfo["type"],
    baseId: string,
    targetPath: string,
    options?: { onComplete?: () => void; onError?: (error: Error) => void },
  ): Promise<void> => {
    try {
      const selectedFiles = mode === "folder" ? await files.showFolderDialog() : await files.showFileDialog({ multiple: true });
      if (selectedFiles.length === 0) return;

      const relativePaths = mode === "folder" ? new Map(selectedFiles.map((file) => [file, file.webkitRelativePath])) : undefined;

      const controller = new AbortController();
      setAbortController(controller);
      setState("isUploading", true);

      const ids = selectedFiles.map((file) => {
        const id = crypto.randomUUID();
        setState("files", (prev) => [
          ...prev,
          {
            id,
            filename: file.name,
            size: file.size,
            progress: 0,
            status: "pending" as UploadStatus,
            relativePath: relativePaths?.get(file),
          },
        ]);
        return id;
      });

      const uploadQueue = selectedFiles.map((file, i) => ({
        file,
        id: ids[i]!,
        relativePath: relativePaths?.get(file),
      }));

      const runUpload = async (item: (typeof uploadQueue)[0]) => {
        if (controller.signal.aborted) return;
        try {
          const dir = item.relativePath?.split("/").slice(0, -1).join("/");
          const uploadPath = dir ? (targetPath === "/" ? `/${dir}` : `${targetPath}/${dir}`) : targetPath;
          await uploadFile(item.file, item.id, baseType, baseId, uploadPath, controller.signal);
        } catch (err) {
          updateFile(item.id, {
            status: "error",
            error: controller.signal.aborted ? messages().cancelled : err instanceof Error ? err.message : messages().uploadFailed,
          });
        }
      };

      const executing: Promise<void>[] = [];
      for (const item of uploadQueue) {
        if (controller.signal.aborted) break;
        const promise = runUpload(item).then(() => {
          executing.splice(executing.indexOf(promise), 1);
        });
        executing.push(promise);
        if (executing.length >= MAX_CONCURRENT_FILES) {
          await Promise.race(executing);
        }
      }
      await Promise.all(executing);

      if (!state.files.some((f) => f.status === "error")) {
        options?.onComplete?.();
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("cancelled")) return;
      options?.onError?.(err instanceof Error ? err : new Error(messages().selectFailed));
    } finally {
      setState("isUploading", false);
      setAbortController(null);
    }
  };

  return {
    state,
    startUpload,
    cancel: () => abortController()?.abort(),
    clearAll: () => setState("files", []),
  };
}

export type UploadManager = ReturnType<typeof createUploadManager>;
