import { beginAppAction } from "@k2b/cloud/browser/reload";
import { z } from "zod";

const UploadResponseSchema = z.object({
  file: z.object({ path: z.string(), mediaType: z.string(), size: z.number(), version: z.number() }),
});
const ErrorSchema = z.object({ message: z.string() });

export type StoredChatFile = z.infer<typeof UploadResponseSchema>["file"];

/**
 * Uploads one file into a chat's files, the same route the AI chat controller uses, and reports its progress from 0 to
 * 100. A request does not report the progress of its body, so this one runs over XMLHttpRequest. Like other writes, it
 * holds automatic app update reloads until it ends.
 */
export const uploadChatFile = (
  conversationId: string,
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<StoredChatFile> =>
  new Promise((resolve, reject) => {
    const finish = beginAppAction();
    const request = new XMLHttpRequest();
    const done = (settle: () => void) => {
      finish();
      signal?.removeEventListener("abort", abort);
      settle();
    };
    const abort = () => request.abort();
    request.open("POST", `/api/ai/conversations/${encodeURIComponent(conversationId)}/files`);
    request.responseType = "json";
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.min(100, (100 * event.loaded) / event.total));
    });
    request.addEventListener("load", () =>
      done(() => {
        const stored = UploadResponseSchema.safeParse(request.response);
        if (request.status >= 200 && request.status < 300 && stored.success) resolve(stored.data.file);
        else reject(new Error(ErrorSchema.safeParse(request.response).data?.message ?? `Upload failed (${request.status})`));
      }),
    );
    request.addEventListener("error", () => done(() => reject(new Error("Upload failed"))));
    request.addEventListener("abort", () => done(() => reject(new DOMException("Upload aborted", "AbortError"))));
    signal?.addEventListener("abort", abort, { once: true });
    const form = new FormData();
    form.append("file", file);
    request.send(form);
  });
