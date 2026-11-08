import type { AppFrameAssets } from "./assets";
import type { AppFiles } from "./compose";
import { type Mount, type MountEvent, mountApp } from "./host";

declare global {
  var lazyChartAssets: AppFrameAssets;
  var lazyChartHarness: {
    mount(files: AppFiles, options?: { sharedSource?: string; theme?: "light" | "dark"; corruptKind?: string }): Promise<void>;
    events: MountEvent[];
    pdfs: unknown[];
    waiting: boolean;
    release(): void;
    snapshot(): Promise<string>;
  };
}
let mount: Mount | undefined;
let release = () => {};
globalThis.lazyChartHarness = {
  events: [],
  pdfs: [],
  waiting: false,
  release: () => release(),
  async mount(files, options = {}) {
    mount?.stop();
    document.documentElement.classList.toggle("dark", options.theme === "dark");
    globalThis.lazyChartHarness.events = [];
    globalThis.lazyChartHarness.pdfs = [];
    const code = options.sharedSource ?? globalThis.lazyChartAssets.chartParts.shared.code;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const chartParts = { ...globalThis.lazyChartAssets.chartParts, shared: { code, hash } };
    if (options.corruptKind) {
      const kind = options.corruptKind;
      chartParts.kinds = {
        ...chartParts.kinds,
        [kind]: { ...chartParts.kinds[kind]!, code: "globalThis.__unverifiedChart=true;" + chartParts.kinds[kind]!.code },
      };
    }
    mount = mountApp(document.querySelector("main")!, files, {
      ...globalThis.lazyChartAssets,
      chartParts,
      title: "Offline charts",
      context: { locale: "en-US", timeZone: "UTC", user: null },
      services: () => ({
        ai: async () => {
          globalThis.lazyChartHarness.waiting = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          globalThis.lazyChartHarness.waiting = false;
          return "finished";
        },
        pdf: async (request) => {
          globalThis.lazyChartHarness.pdfs.push(request);
          return new Blob(["fixture PDF"], { type: "application/pdf" });
        },
      }),
      confirmOpen: async () => false,
      onEvent: (event) => globalThis.lazyChartHarness.events.push(event),
    });
  },
  snapshot: () => mount!.snapshot(),
};
