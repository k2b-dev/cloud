// Standalone subprocess. No server imports or application credentials.
import { readSync } from "node:fs";
import { readImageFrame } from "./image-protocol";
import { prepareImageVariants } from "./image-variants";

const write = (chunk: string | Uint8Array) =>
  new Promise<void>((resolve, reject) => {
    process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
// Timers bound processing. During blocking stdin reads, a crashed parent closes the pipe;
// a live parent enforces its deadline with SIGKILL.
const expire = () => process.exit(1);
let timer = setTimeout(expire, 240_000);
try {
  let frame: ReturnType<typeof readImageFrame> | undefined = readImageFrame((buffer, offset, length) =>
    readSync(0, buffer, offset, length, null),
  );
  const request = frame.header;
  clearTimeout(timer);
  timer = setTimeout(expire, request.timeoutMs);
  const pending = prepareImageVariants(frame.body, request, async (index, header, bytes) => {
    await write(`${JSON.stringify({ index, ...header })}\n`);
    await write(bytes);
  });
  frame = undefined;
  await write(`${JSON.stringify(await pending)}\n`);
} catch {
  await write(`${JSON.stringify({ ok: false, code: "unreadable" })}\n`).catch(() => {});
} finally {
  clearTimeout(timer);
}
