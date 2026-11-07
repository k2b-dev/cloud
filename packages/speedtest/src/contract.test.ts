import { expect, test } from "bun:test";
import manifest from "../package.json";

test("the measurement engine and browser transport build without server or Cloud dependencies", async () => {
  expect(manifest).not.toHaveProperty("dependencies");
  for (const entry of ["./engine.ts", "./browser.ts"]) {
    const result = await Bun.build({ entrypoints: [new URL(entry, import.meta.url).pathname], target: "browser" });
    expect(result.success).toBe(true);
    expect(result.logs.filter((log) => log.level === "error")).toEqual([]);
    const output = await result.outputs[0]!.text();
    expect(output).not.toContain("@k2b/cloud");
    expect(output).not.toContain("node:");
  }
});
