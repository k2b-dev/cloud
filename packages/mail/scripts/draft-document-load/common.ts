import { appendFileSync } from "node:fs";
import { loadavg } from "node:os";

const within = async <T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export { within };
export const checkHost = () => {
  if ((loadavg()[0] ?? 0) > 32) throw new Error("Host one-minute load exceeds 32");
};
export const writeSample = (path: string, row: unknown) => appendFileSync(path, `${JSON.stringify(row)}\n`);

/** TCP may split even the HTTP status line; wait for bounded, complete headers. */
export const upgradeComplete = (header: string): boolean => {
  if (header.length > 16384) throw new Error("Slow consumer upgrade headers exceeded 16 KiB");
  if (!header.includes("\r\n\r\n")) return false;
  if (!header.startsWith("HTTP/1.1 101 ")) throw new Error(`Slow consumer upgrade failed: ${header.slice(0, 500)}`);
  return true;
};
