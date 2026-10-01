import { LocaleProvider, toast } from "@k2b/ui";
import { render } from "solid-js/web";
import { UploadSurface } from "./UploadPanel";
import { createUploadQueue, type UploadOutcome, type UploadQueue } from "./upload-queue";

/** Drives the real upload panel from a browser test: every transfer waits until the test settles it. */
type Transfer = {
  path: string;
  progress: (bytes: number) => void;
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
          upload: (_, item, { signal, onProgress }) =>
            new Promise((resolve, reject) => {
              transfers.push({ path: item.path, progress: onProgress, resolve, reject });
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
          notify: (text) => toast(text),
          queue,
        };
        return <UploadSurface queue={queue} />;
      })()}
    </LocaleProvider>
  ),
  host,
);
