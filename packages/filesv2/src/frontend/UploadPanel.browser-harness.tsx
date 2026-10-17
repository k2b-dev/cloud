import { LocaleProvider, toast } from "@k2b/ui";
import { render } from "solid-js/web";
import { UploadTransferError, type UploadTransferKind } from "../upload-transfer";
import { UploadSurface } from "./UploadPanel";
import { createUploadQueue, type UploadOutcome, type UploadQueue } from "./upload-queue";

/** Drives the real upload panel from a browser test: every transfer waits until the test settles it. */
type Transfer = {
  path: string;
  progress: (bytes: number) => void;
  alive: () => void;
  finishing: () => void;
  resolve: (outcome: UploadOutcome) => void;
  reject: (error: Error) => void;
};

declare global {
  interface Window {
    uploads: {
      add: (files: [path: string, size: number][], target?: string) => void;
      progress: (bytes: number) => void;
      finish: () => void;
      fail: (reason: string) => void;
      /** Fails the current try the way a transfer does, so the queue waits and tries the same file again. */
      interrupt: (kind: UploadTransferKind, retryAfter?: number) => void;
      /** The current try heard from Cloud. */
      alive: () => void;
      /** The current try has sent every byte and waits for Cloud to publish the file. */
      finishing: () => void;
      /** Any other toast, shown while the panel is in the rail. */
      notify: (text: string) => void;
      queue: UploadQueue<null>;
    };
  }
}

const transfers: Transfer[] = [];
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      {(() => {
        const queue = createUploadQueue<null>({
          reason: (error) => (error instanceof Error ? error.message : "failed"),
          upload: (_, item, { signal, onProgress, onPhase, alive }) =>
            new Promise((resolve, reject) => {
              transfers.push({ path: item.path, progress: onProgress, alive, finishing: () => onPhase("finishing"), resolve, reject });
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        });
        const current = () => transfers.at(-1)!;
        window.uploads = {
          add: (files, target = "Projects") =>
            queue.add(
              null,
              { key: target, label: target },
              files.map(([path, size]) => ({ file: new File([new Uint8Array(size)], path.split("/").at(-1)!), path })),
            ),
          progress: (bytes) => current().progress(bytes),
          finish: () => current().resolve({ status: "uploaded", path: current().path }),
          fail: (reason) => current().reject(new Error(reason)),
          interrupt: (kind, retryAfter) => current().reject(new UploadTransferError("failed", kind, null, retryAfter)),
          alive: () => current().alive(),
          finishing: () => current().finishing(),
          notify: (text) => toast(text),
          queue,
        };
        return <UploadSurface queue={queue} />;
      })()}
    </LocaleProvider>
  ),
  host,
);
