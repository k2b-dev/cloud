import { expect, test } from "bun:test";
import { options } from "./draft-document-load";
import { upgradeComplete } from "./draft-document-load/common";

test("load arguments enforce the bounded workload and preserve explicit resource budgets", () => {
  expect(options(["--bounded", "--drafts", "50", "--clients", "3", "--seconds", "90", "--rss-mib", "768"])).toMatchObject({
    bounded: true,
    drafts: 50,
    clients: 3,
    seconds: 90,
    rssMib: 768,
  });
  for (const args of [
    ["--seconds", "601"],
    ["--clients", "1"],
    ["--drafts", "501"],
    ["--interval-ms", "0"],
    ["--rss-mib", "NaN"],
    ["--burst-bytes", "262145"],
    ["--body-bytes", "1024", "--burst-bytes", "2048"],
  ]) {
    expect(() => options(args)).toThrow();
  }
});

test("help does not import Mail or reach configured infrastructure", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/draft-document-load.ts`, "--help"], {
    env: { ...process.env, CLOUD_TEST_DATABASE_URL: "postgres://127.0.0.1:1/invalid", CLOUD_TEST_NATS_SERVERS: "nats://127.0.0.1:1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("--rss-mib");
  expect(stdout).toContain("CLOUD_TEST_DATABASE_URL");
});

test("slow consumer waits for a fragmented upgrade response and bounds its headers", () => {
  expect(upgradeComplete("HTTP/1.1 ")).toBe(false);
  expect(upgradeComplete("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n")).toBe(false);
  expect(upgradeComplete("HTTP/1.1 101 Switching Protocols\r\n\r\n")).toBe(true);
  expect(() => upgradeComplete("HTTP/1.1 403 Forbidden\r\n\r\n")).toThrow("403");
  expect(() => upgradeComplete("x".repeat(16385))).toThrow("16 KiB");
});
