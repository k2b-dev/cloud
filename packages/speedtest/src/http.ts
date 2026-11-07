import { normalizeServer, SpeedtestError, type Transport } from "./engine";

export function checkResponse(response: Response): void {
  if (response.ok) return;
  const retry = Number(response.headers.get("retry-after"));
  throw new SpeedtestError(
    "http",
    `Speedtest HTTP ${response.status}`,
    response.status,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
  );
}
export function createHttpTransport(
  server: string,
  upload: Transport["upload"],
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Transport {
  const base = normalizeServer(server);
  return {
    async ping(signal) {
      const response = await request(`${base}/ping`, { signal, cache: "no-store", credentials: "omit" });
      try {
        checkResponse(response);
      } finally {
        await response.body?.cancel();
      }
    },
    async download(bytes, count, signal) {
      const response = await request(`${base}/download?size=${bytes}`, { signal, cache: "no-store", credentials: "omit" });
      if (!response.ok) {
        await response.body?.cancel();
        checkResponse(response);
      }
      if (!response.body) throw new SpeedtestError("network", "Missing download body");
      const reader = response.body.getReader();
      try {
        while (!signal.aborted) {
          const part = await reader.read();
          if (part.done) return;
          count(part.value.byteLength);
        }
      } finally {
        await reader.cancel().catch(() => {}); // The owning phase reports abort/errors.
        reader.releaseLock();
      }
    },
    upload,
  };
}
