import type { AppFrameAssets } from "./assets";
import type { AppFiles } from "./compose";
import { type Mount, type MountEvent, mountApp } from "./host";

declare global {
  var lazyChartAssets: AppFrameAssets;
  var lazyChartHarness: {
    mount(files: AppFiles, options?: { chartModule?: string; theme?: "light" | "dark" }): void;
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
  mount(files, options = {}) {
    mount?.stop();
    document.documentElement.classList.toggle("dark", options.theme === "dark");
    globalThis.lazyChartHarness.events = [];
    globalThis.lazyChartHarness.pdfs = [];
    mount = mountApp(document.querySelector("main")!, files, {
      ...globalThis.lazyChartAssets,
      chartModule: options.chartModule ?? globalThis.lazyChartAssets.chartModule,
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
