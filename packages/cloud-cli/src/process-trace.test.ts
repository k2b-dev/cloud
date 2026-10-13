import { expect, spyOn, test } from "bun:test";
import { traced } from "../test/fixtures/process-trace";

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

test("the watchdog reports a running child with partial output before it finishes", async () => {
  const reported = Promise.withResolvers<string>();
  const logged = spyOn(console, "error").mockImplementation((message: unknown) => reported.resolve(String(message)));
  const completion = traced(5300, async (trace) => {
    await trace.phase("wait for child", () =>
      trace.spawn(
        "sleeping writer",
        [
          process.execPath,
          "-e",
          `
      console.log("partial line");
      await Bun.sleep(1000);
    `,
        ],
        {},
      ),
    );
  })();
  try {
    const report = await reported.promise;
    expect(report.split("\n")[0]).toMatch(/^Test is close to its deadline after \d+ ms/);
    expect(report).toMatch(/wait for child: start \d+ ms, running since \d+ ms/);
    expect(report).toMatch(/sleeping writer: start \d+ ms, running since \d+ ms, pid \d+/);
    expect(report).toContain("exited=no, exitCode=null");
    expect(report).toContain("stdout 13 bytes EOF=no");
    expect(report).toContain("stderr 0 bytes EOF=no");
    expect(report).toContain("    partial line");
    await completion;
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    await completion;
    logged.mockRestore();
  }
});

test.skipIf(process.platform === "win32")(
  "the watchdog distinguishes an exited child from a descendant holding its pipe open",
  async () => {
    const reported = Promise.withResolvers<string>();
    const logged = spyOn(console, "error").mockImplementation((message: unknown) => reported.resolve(String(message)));
    const completion = traced(5300, async (trace) => {
      const result = await trace.spawn("shell with descendant", ["sh", "-c", "sleep 2 & exit 0"], {});
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    })();
    try {
      const report = await reported.promise;
      expect(report).toMatch(/shell with descendant: start \d+ ms, \d+ ms, pid \d+/);
      expect(report).toContain("exited=yes, exitCode=0, signalCode=null");
      expect(report).toContain("stdout 0 bytes EOF=no");
      await completion;
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      await completion;
      logged.mockRestore();
    }
  },
);
