import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { CHUNK_BYTES, normalizeServer, SpeedtestError, type Transport } from "./engine";
import { createHttpTransport } from "./http";

/** Node's writable backpressure bounds counted-but-buffered upload bytes to the socket queue. */
export function createNodeTransport(server: string): Transport {
  const url = new URL(`${normalizeServer(server)}/upload`);
  const chunk = new Uint8Array(CHUNK_BYTES);
  crypto.getRandomValues(chunk);
  return createHttpTransport(
    server,
    (bytes, count, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
          url,
          {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/octet-stream", "Content-Length": bytes },
          },
          (response) => {
            response.resume();
            if (response.statusCode !== 200) {
              const retry = Number(response.headers["retry-after"]);
              const error = new SpeedtestError(
                "http",
                `Speedtest HTTP ${response.statusCode}`,
                response.statusCode,
                retry > 0 ? retry : undefined,
              );
              request.destroy(error);
              reject(error);
            } else response.once("end", resolve);
            response.once("error", reject);
          },
        );
        let written = 0;
        const write = () => {
          while (written < bytes && !signal.aborted && !request.destroyed) {
            const part = chunk.subarray(0, Math.min(CHUNK_BYTES, bytes - written));
            written += part.byteLength;
            const ready = request.write(part, (error) => {
              if (error) return;
              if (!signal.aborted) count(part.byteLength);
            });
            if (!ready) {
              request.once("drain", write);
              return;
            }
          }
          if (written >= bytes) request.end();
        };
        request.once("error", reject);
        write();
      }),
  );
}
