import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import SpeedTest from "./SpeedTest.island";

// Deterministic network fixtures for the real component and shared engine; no product state switches.
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "idle";
const nativeFetch = globalThis.fetch;
const chunk = new Uint8Array(256 * 1024);
let attempts = 0;
const aborted = () => new DOMException("Aborted", "AbortError");
const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== "https://speedtest.k2b.dev") return nativeFetch(input, init);
  if (url.pathname.endsWith("/ping")) {
    attempts++;
    if (scenario === "error" || (scenario === "retry" && attempts === 1)) throw new TypeError("Fixture offline server");
    await new Promise<void>((resolve, reject) => {
      const signal = init?.signal;
      const stop = () => {
        clearTimeout(timer);
        reject(aborted());
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", stop);
          resolve();
        },
        scenario === "ping" ? 180 : 12,
      );
      signal?.addEventListener("abort", stop, { once: true });
    });
    return new Response(null, { status: 204 });
  }
  if (scenario === "429") return new Response(null, { status: 429, headers: { "Retry-After": "2" } });
  let sent = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (init?.signal?.aborted) {
          controller.error(aborted());
          return;
        }
        if (sent >= 25 * 1024 * 1024) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    }),
  );
};
Object.defineProperty(globalThis, "fetch", { value: fixtureFetch });
class FixtureXhr {
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  status = 200;
  timer: ReturnType<typeof setInterval> | undefined;
  open() {}
  setRequestHeader() {}
  getResponseHeader() {
    return null;
  }
  send() {
    let loaded = 0;
    this.timer = setInterval(() => {
      loaded += 128 * 1024;
      this.upload.onprogress?.({ loaded });
      if (loaded >= 16 * 1024 * 1024) {
        clearInterval(this.timer);
        this.onload?.();
      }
    }, 25);
  }
  abort() {
    clearInterval(this.timer);
    this.onabort?.();
  }
}
Object.defineProperty(globalThis, "XMLHttpRequest", { value: FixtureXhr });
if (scenario === "offline") Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true });
const lang = params.get("lang") ?? document.documentElement.lang;
document.documentElement.lang = lang;
render(
  () => (
    <LocaleProvider locale={lang}>
      <main class="mx-auto w-full max-w-5xl p-4 flex flex-col gap-4">
        <header class="tools-tool-header">
          <h1 class="text-xl font-semibold">{lang === "de" ? "Internet-Speedtest" : "Internet Speed Test"}</h1>
        </header>
        <SpeedTest server="https://speedtest.k2b.dev" enabled={scenario !== "disabled"} />
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
if (!["idle", "offline", "disabled"].includes(scenario))
  requestAnimationFrame(() => {
    document.querySelector<HTMLButtonElement>(".tools-speedtest-measure > button")?.click();
    if (scenario === "cancel")
      setTimeout(() => document.querySelector<HTMLButtonElement>(".tools-speedtest-measure > button")?.click(), 500);
  });
