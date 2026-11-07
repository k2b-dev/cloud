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
  upload: (bytes: number, count: (bytes: number) => void, signal: AbortSignal, headers: Record<string, string>) => Promise<void>,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Transport {
  const base = normalizeServer(server);
  let token: string | undefined;
  const sessionHeaders = (): Record<string, string> => (token ? { "X-Speedtest-Token": token } : {});
  return {
    async begin(mode, signal) {
      if (token) throw new SpeedtestError("network", "A test is already running");
      const response = await request(`${base}/session?mode=${mode}`, { method: "POST", credentials: "omit", cache: "no-store", signal });
      if (!response.ok) {
        await response.body?.cancel();
        checkResponse(response);
      }
      const session: unknown = await response.json();
      if (
        !session ||
        typeof session !== "object" ||
        !("token" in session) ||
        typeof session.token !== "string" ||
        !/^[0-9a-f-]{36}$/.test(session.token)
      )
        throw new SpeedtestError("network", "Invalid test admission");
      token = session.token;
      if (signal.aborted) {
        this.end?.();
        signal.throwIfAborted();
      }
    },
    end() {
      if (!token) return;
      const headers = sessionHeaders();
      token = undefined;
      // Best effort, bounded cleanup. Server expiry remains authoritative after disconnects.
      void request(`${base}/session/end`, { method: "POST", headers, credentials: "omit", signal: AbortSignal.timeout(500) })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    },
    async ping(signal) {
      const response = await request(`${base}/ping`, { signal, headers: sessionHeaders(), cache: "no-store", credentials: "omit" });
      try {
        checkResponse(response);
      } finally {
        await response.body?.cancel();
      }
    },
    async download(bytes, count, signal) {
      const response = await request(`${base}/download?size=${bytes}`, {
        signal,
        headers: sessionHeaders(),
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok) {
        await response.body?.cancel();
        checkResponse(response);
      }
      if (!response.body) throw new SpeedtestError("network", "Missing download body");
      const reader = response.body.getReader();
      let received = 0;
      try {
        while (!signal.aborted) {
          const part = await reader.read();
          if (part.done) {
            if (received !== bytes) throw new SpeedtestError("network", "Incomplete speedtest download");
            return;
          }
          received += part.value.byteLength;
          count(part.value.byteLength);
        }
      } catch (error) {
        if (!signal.aborted && token) {
          const response = await request(`${base}/session`, { signal, headers: sessionHeaders(), credentials: "omit", cache: "no-store" });
          if (response.ok) {
            const status: unknown = await response.json();
            if (status && typeof status === "object" && "limited" in status && status.limited === true)
              throw new SpeedtestError("capacity", "Server bandwidth budget exceeded", 503, 1);
          } else await response.body?.cancel();
        }
        throw error;
      } finally {
        await reader.cancel().catch(() => {}); // The owning phase reports abort/errors.
        reader.releaseLock();
      }
    },
    upload: (bytes, count, signal) => upload(bytes, count, signal, sessionHeaders()),
  };
}
