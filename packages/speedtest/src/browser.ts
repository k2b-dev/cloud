import { normalizeServer, SpeedtestError, type Transport } from "./engine";
import { createHttpTransport } from "./http";

export function createBrowserTransport(server: string): Transport {
  const base = normalizeServer(server);
  let payload: Blob | undefined;
  return createHttpTransport(
    base,
    (bytes, count, signal, headers) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        // Allocate lazily, once per test; no source data or Cloud credentials leave the browser.
        if (payload?.size !== bytes) {
          const data = new Uint8Array(bytes);
          for (let offset = 0; offset < bytes; offset += 65_536) crypto.getRandomValues(data.subarray(offset, offset + 65_536));
          // Reuse immutable backing storage; sending a typed array copies 16 MiB for every request on the main thread.
          payload = new Blob([data], { type: "application/octet-stream" });
        }
        const xhr = new XMLHttpRequest();
        let sent = 0;
        const abort = () => xhr.abort();
        const finish = (error?: unknown) => {
          signal.removeEventListener("abort", abort);
          xhr.upload.onprogress = null;
          xhr.onload = xhr.onerror = xhr.onabort = null;
          if (error) reject(error);
          else resolve();
        };
        xhr.open("POST", `${base}/upload`);
        xhr.withCredentials = false;
        for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (event) => {
          if (signal.aborted) return;
          count(Math.max(0, event.loaded - sent));
          sent = event.loaded;
        };
        xhr.onload = () => {
          const retry = Number(xhr.getResponseHeader("Retry-After"));
          if (xhr.status < 200 || xhr.status >= 300)
            finish(
              new SpeedtestError(
                "http",
                `Speedtest HTTP ${xhr.status}`,
                xhr.status,
                Number.isFinite(retry) && retry > 0 ? retry : undefined,
              ),
            );
          else finish();
        };
        xhr.onerror = () => finish(new SpeedtestError("network", "Upload connection failed"));
        xhr.onabort = () => finish(signal.reason ?? new SpeedtestError("cancelled", "Upload cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        xhr.send(payload);
      }),
  );
}
