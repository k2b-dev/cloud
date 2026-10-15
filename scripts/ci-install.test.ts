import { expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "./ci-install";

test("succeeds on the first attempt without cleaning or retrying", async () => {
  const clean = mock(async () => {});
  const log = mock(() => {});
  expect(await install({ command: ["bun", "-e", "process.exit(0)"], clean, log })).toBe(0);
  expect(clean).not.toHaveBeenCalled();
  expect(log.mock.calls).toHaveLength(1);
  expect(log.mock.calls[0]).toEqual([expect.stringContaining("attempt 1 finished after")]);
});

test("returns a non-stall failure's exit code without cleaning or retrying", async () => {
  const clean = mock(async () => {});
  const log = mock(() => {});
  expect(await install({ command: ["bun", "-e", "process.exit(3)"], clean, log })).toBe(3);
  expect(clean).not.toHaveBeenCalled();
  expect(log.mock.calls).toEqual([
    [expect.stringContaining("attempt 1 finished after")],
    ["::error title=bun ci failed::bun ci exited with 3"],
  ]);
});

/** A counter records actual process starts, including attempts stopped by the bound. */
const stalledInstall = async (bothStall: boolean, ignoreTerm = false) => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-ci-install-"));
  const counter = join(dir, "attempts");
  const clean = mock(async () => {});
  const log = mock(() => {});
  try {
    const code = await install({
      command: [
        "bun",
        "-e",
        `const file = Bun.file(process.argv[1]);
         const attempt = await file.exists() ? Number(await file.text()) + 1 : 1;
         await Bun.write(file, String(attempt));
         if (${ignoreTerm}) process.on("SIGTERM", () => {});
         if (attempt === 1 || ${bothStall}) await Bun.sleep(60_000);`,
        counter,
      ],
      limitMs: 1500,
      killAfterMs: 100,
      clean,
      log,
    });
    return { code, attempts: Number(await readFile(counter, "utf8")), clean, log };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("cleans once and retries when the first attempt stalls", async () => {
  const { code, attempts, clean, log } = await stalledInstall(false);
  expect(code).toBe(0);
  expect(attempts).toBe(2);
  expect(clean).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.flat()).toContainEqual(expect.stringContaining("::warning title=bun ci stalled::"));
});

test("fails after exactly two stalls, including a process that ignores SIGTERM", async () => {
  const { code, attempts, clean, log } = await stalledInstall(true, true);
  expect(code).toBe(1);
  expect(attempts).toBe(2);
  expect(clean).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.flat()).toContainEqual(expect.stringContaining("::error title=bun ci stalled::"));
});
