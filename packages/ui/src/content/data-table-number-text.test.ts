import { expect, test } from "bun:test";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

registerSsrTestPlugin({ dev: true, rootDir: import.meta.dir });
const { tableCellText } = await import("./data-table-columns");

test("number text keeps significant digits and formats short mantissas", () => {
  for (const value of ["1234567890123456", "1.234567890123456e+10", "-0.000123456789012345678"])
    expect(tableCellText(value, { type: "number" }, "en")).toBe(value);
  for (const value of ["1234.5000", "1.2345e3", "+001234.5000"]) expect(tableCellText(value, { type: "number" }, "en")).toBe("1,234.5");
  for (const value of ["E".repeat(1000), "123abc", "Infinity"]) expect(tableCellText(value, { type: "number" }, "en")).toBe(value);
});

test("long fractional text finishes within the isolated formatting budget", () => {
  // Measure formatting after imports; the subprocess timeout separately bounds startup and synchronous work.
  const run = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import { createConfig } from ${JSON.stringify(import.meta.resolve("@k2b/ssr"))};
    Bun.plugin(createConfig({ dev: true, rootDir: ${JSON.stringify(import.meta.dir)} }).plugin());
    const { tableCellText } = await import(${JSON.stringify(new URL("./data-table-columns.ts", import.meta.url).pathname)});
    const value = "1." + "0".repeat(200_000) + "1";
    const start = performance.now();
    if (tableCellText(value, { type: "number" }, "en") !== value) throw new Error("Number text changed");
    if (performance.now() - start > 500) throw new Error("Formatting exceeded its 500 ms budget");
    console.log("formatted");
  `,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 15_000 },
  );
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toBe("formatted\n");
}, 20_000);
