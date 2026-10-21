import type { CDPSession, Page, Request } from "playwright";
import { validatePage } from "../../../../scripts/perf-baseline/model";

type ByteKey = "htmlBytes" | "jsBytes" | "cssBytes";
const byteKey = (type: string, url: string, target: string): ByteKey | null => {
  if (type.toLowerCase() === "document" || (["fetch", "xhr"].includes(type.toLowerCase()) && new URL(url).pathname === target))
    return "htmlBytes";
  if (type.toLowerCase() === "script") return "jsBytes";
  if (type.toLowerCase() === "stylesheet") return "cssBytes";
  return null;
};

/** Cache body/header estimates can cancel each other; clamp only their sum. Chromium uses CDP instead. */
export const webkitTransferBytes = (size: { responseBodySize: number; responseHeadersSize: number }) =>
  Math.max(0, size.responseBodySize + size.responseHeadersSize);

/** Each observed request needs its own transfer; unrelated CDP starts are outside the frozen set. */
export function matchPageChangeTransfers<T extends { url: string }>(urls: string[], transfers: T[]): T[] {
  const remaining = [...transfers];
  return urls.map((url) => {
    const index = remaining.findIndex((record) => record.url === url);
    if (index < 0) throw new Error(`Missing page-change CDP request: ${new URL(url).pathname}`);
    return remaining.splice(index, 1)[0]!;
  });
}

export async function boundedSettlement<T>(jobs: Promise<T>[], timeoutMs: number): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all(jobs),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Page-change requests did not settle within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Freeze starts at the observed end state, then settle that exact set before reading bytes or responses. */
export function recordPageChangeNetwork(page: Page, target: string, cdp?: CDPSession) {
  let collecting = true;
  const beganAt = Date.now();
  let endedAt = Infinity;
  const requests = new Map<Request, { key: ByteKey; done: Promise<string | null>; finish: (error: string | null) => void }>();
  const transfers = new Map<string, { key: ByteKey; url: string; done: Promise<void>; finish: () => void; bytes: number }>();
  const providerDocuments: Request[] = [];
  const onRequest = (request: Request) => {
    if (!collecting) return;
    const key = byteKey(request.resourceType(), request.url(), target);
    if (!key) return;
    let finish!: (error: string | null) => void;
    const done = new Promise<string | null>((resolve) => {
      finish = resolve;
    });
    requests.set(request, { key, done, finish });
    if (request.isNavigationRequest() && request.frame() !== page.mainFrame() && new URL(request.url()).pathname.includes("panel"))
      providerDocuments.push(request);
  };
  const onFinished = (request: Request) => requests.get(request)?.finish(null);
  const onFailed = (request: Request) => requests.get(request)?.finish(request.failure()?.errorText ?? "request failed");
  const onCdpRequest = (event: {
    requestId: string;
    wallTime: number;
    type?: string;
    request: { url: string };
    redirectResponse?: { encodedDataLength: number };
  }) => {
    const previous = transfers.get(event.requestId);
    if (previous && event.redirectResponse) previous.bytes += event.redirectResponse.encodedDataLength;
    if (event.wallTime * 1000 < beganAt || event.wallTime * 1000 > endedAt) return;
    const key = byteKey(event.type ?? "other", event.request.url, target);
    if (!key || previous) return;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    transfers.set(event.requestId, { key, url: event.request.url, done, finish, bytes: 0 });
  };
  const onCdpFinished = (event: { requestId: string; encodedDataLength: number }) => {
    const entry = transfers.get(event.requestId);
    if (!entry) return;
    entry.bytes += event.encodedDataLength;
    entry.finish();
  };
  const onCdpFailed = (event: { requestId: string }) => transfers.get(event.requestId)?.finish();
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  cdp?.on("Network.requestWillBeSent", onCdpRequest);
  cdp?.on("Network.loadingFinished", onCdpFinished);
  cdp?.on("Network.loadingFailed", onCdpFailed);
  return {
    providerDocuments,
    async finish(timeoutMs = 10_000) {
      endedAt = Date.now();
      collecting = false;
      const frozen = [...requests];
      const outcomes = await boundedSettlement(
        frozen.map(([, record]) => record.done),
        timeoutMs,
      );
      const failed = outcomes.flatMap((error, index) => (error ? [`${new URL(frozen[index]![0].url()).pathname}: ${error}`] : []));
      if (failed.length) throw new Error(`Page-change resource failed: ${failed.join("; ")}`);
      // Playwright and our CDP session deliver on separate channels. Keep accepting CDP starts
      // by their browser timestamp until the frozen Playwright set settles, then drain this channel.
      if (cdp) await cdp.send("Runtime.evaluate", { expression: "0" });
      const encoded = cdp
        ? matchPageChangeTransfers(
            frozen.map(([request]) => request.url()),
            [...transfers.values()],
          )
        : [];
      if (cdp) {
        await boundedSettlement(
          encoded.map((record) => record.done),
          timeoutMs,
        );
      }
      let destination = false;
      const sizes = { htmlBytes: 0, jsBytes: 0, cssBytes: 0 };
      for (const [request, record] of frozen) {
        const response = await request.response();
        if (!response) throw new Error(`Missing page-change response: ${new URL(request.url()).pathname}`);
        if (!response.ok()) throw new Error(`Page-change resource returned ${response.status()}: ${new URL(request.url()).pathname}`);
        if (new URL(request.url()).pathname === target && request.frame() === page.mainFrame() && record.key === "htmlBytes") {
          if (!response.headers()["content-type"]?.includes("text/html")) throw new Error("Page-change destination was not HTML");
          validatePage(response.status(), new URL(target, page.url()).href, page.url(), await response.text());
          destination = true;
        }
        if (!cdp) sizes[record.key] += webkitTransferBytes(await request.sizes());
      }
      if (!destination) throw new Error("Missing page-change destination response");
      if (cdp) {
        if (!encoded.length) throw new Error("Missing page-change CDP transfer evidence");
        for (const record of encoded) sizes[record.key] += record.bytes;
      }
      return sizes;
    },
    stop() {
      collecting = false;
      page.off("request", onRequest);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
      cdp?.off("Network.requestWillBeSent", onCdpRequest);
      cdp?.off("Network.loadingFinished", onCdpFinished);
      cdp?.off("Network.loadingFailed", onCdpFailed);
    },
  };
}
