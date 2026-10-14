import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processTrace, traced } from "../test/fixtures/process-trace";

test("a failure reports completed steps and output, rethrows the error, and success stays silent", async () => {
  const error = new Error("body failed");
  const stdout = `discarded prefix\n${"x".repeat(2000)}é\n`;
  const stderr = "warning\n";
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      traced(60_000, async (trace) => {
        expect(await trace.phase("prepare", async () => 42)).toBe(42);
        const result = await trace.spawn(
          "writer",
          [
            process.execPath,
            "-e",
            `
        const bytes = new TextEncoder().encode(${JSON.stringify(stdout)});
        await Bun.write(Bun.stdout, bytes.subarray(0, bytes.length - 2));
        await Bun.sleep(10);
        await Bun.write(Bun.stdout, bytes.subarray(bytes.length - 2));
        await Bun.write(Bun.stderr, ${JSON.stringify(stderr)});
      `,
            "--token",
            "hidden-token",
          ],
          { env: { ...process.env, TRACE_SECRET: "hidden-environment" } },
        );
        expect(result).toEqual({ exitCode: 0, stdout, stderr });
        await trace.phase("fail", async () => {
          throw error;
        });
      })(),
    ).rejects.toBe(error);
    expect(logged).toHaveBeenCalledTimes(1);
    const report = String(logged.mock.calls[0]?.[0]);
    expect(report).toMatch(/prepare: start \d+ ms, \d+ ms/);
    expect(report).toMatch(/writer: start \d+ ms, \d+ ms, pid \d+, exited=yes, exitCode=0, signalCode=null/);
    expect(report).toContain(`stdout ${new TextEncoder().encode(stdout).byteLength} bytes EOF=yes`);
    expect(report).toContain("stderr 8 bytes EOF=yes");
    expect(report).toContain(`    ${stdout.slice(-2000).trimEnd()}`);
    expect(report).toContain("    warning");
    expect(report).not.toContain("discarded prefix");
    expect(report).not.toContain("hidden-token");
    expect(report).not.toContain("hidden-environment");
    expect(report).toMatch(/fail: start \d+ ms, \d+ ms, failed/);
    expect(report.indexOf("prepare:")).toBeLessThan(report.indexOf("writer:"));
    expect(report.indexOf("writer:")).toBeLessThan(report.indexOf("fail:"));
    logged.mockClear();
    await traced(5050, async (trace) => {
      await trace.phase("pass", async () => {});
    })();
    await Bun.sleep(100);
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});

/** A directory whose `release` file unblocks the children that wait for it. */
const gate = async () => {
  const directory = await mkdtemp(join(tmpdir(), "process-trace-"));
  const path = join(directory, "release");
  return { path, release: () => Bun.write(path, ""), remove: () => rm(directory, { recursive: true, force: true }) };
};
const waitForRelease = `
  const { existsSync } = await import("node:fs");
  while (!existsSync(process.argv.at(-1))) await Bun.sleep(10);
`;
/** Wait for an observed state, not for an amount of time; the test timeout is the only bound. */
const described = async (describe: (reason: string) => string, expected: string) => {
  while (true) {
    const report = describe("Snapshot");
    if (report.includes(expected)) return report;
    await Bun.sleep(5);
  }
};

test("a running child is reported with partial output before it finishes", async () => {
  const { trace, describe } = processTrace();
  const held = await gate();
  const completion = trace.phase("wait for child", () =>
    trace.spawn("sleeping writer", [process.execPath, "-e", `console.log("partial line");${waitForRelease}`, held.path], {}),
  );
  try {
    const report = await described(describe, "stdout 13 bytes");
    expect(report.split("\n")[0]).toMatch(/^Snapshot after \d+ ms; process trace:$/);
    expect(report).toMatch(/wait for child: start \d+ ms, running since \d+ ms/);
    expect(report).toMatch(/sleeping writer: start \d+ ms, running since \d+ ms, pid \d+/);
    expect(report).toContain("exited=no, exitCode=null");
    expect(report).toContain("stdout 13 bytes EOF=no");
    expect(report).toContain("stderr 0 bytes EOF=no");
    expect(report).toContain("    partial line");
    await held.release();
    expect(await completion).toEqual({ exitCode: 0, stdout: "partial line\n", stderr: "" });
    const finished = describe("Snapshot");
    expect(finished).toContain("exited=yes, exitCode=0");
    expect(finished).toContain("stdout 13 bytes EOF=yes");
  } finally {
    try {
      await held.release();
      await completion;
    } finally {
      await held.remove();
    }
  }
});

test.skipIf(process.platform === "win32")("an exited child is distinguished from a descendant holding its pipe open", async () => {
  const { trace, describe } = processTrace();
  const held = await gate();
  const completion = trace.spawn(
    "shell with descendant",
    ["sh", "-c", 'while [ ! -e "$1" ]; do sleep 0.05; done & exit 0', "sh", held.path],
    {},
  );
  try {
    const report = await described(describe, "exited=yes");
    expect(report).toMatch(/shell with descendant: start \d+ ms, \d+ ms, pid \d+/);
    expect(report).toContain("exited=yes, exitCode=0, signalCode=null");
    expect(report).toContain("stdout 0 bytes EOF=no");
    await held.release();
    expect(await completion).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  } finally {
    try {
      await held.release();
      await completion;
    } finally {
      await held.remove();
    }
  }
});

test("the watchdog fires on the real timer while a child runs, and a later failure reports again", async () => {
  const error = new Error("body failed");
  const reported = Promise.withResolvers<string>();
  const held = await gate();
  const logged = spyOn(console, "error").mockImplementation((message: unknown) => reported.resolve(String(message)));
  const completion = traced(5300, async (trace) => {
    await trace.phase("wait for child", () => trace.spawn("blocked child", [process.execPath, "-e", waitForRelease, held.path], {}));
    throw error;
  })();
  const settled = completion.catch(() => {});
  try {
    // Only what holds however far the child has come when the timer fires.
    const report = await reported.promise;
    expect(report.split("\n")[0]).toMatch(/^Test is close to its deadline after \d+ ms/);
    expect(report).toMatch(/wait for child: start \d+ ms, running since \d+ ms/);
    expect(report).toMatch(/blocked child: start \d+ ms, running since \d+ ms, pid \d+/);
    expect(report).toContain("exited=no, exitCode=null");
    await held.release();
    await expect(completion).rejects.toBe(error);
    expect(logged).toHaveBeenCalledTimes(2);
    const failure = String(logged.mock.calls[1]?.[0]);
    expect(failure).toMatch(/^Test failed after \d+ ms/);
    expect(failure).toContain("exited=yes, exitCode=0");
  } finally {
    try {
      await held.release();
      await settled;
    } finally {
      logged.mockRestore();
      await held.remove();
    }
  }
});
