import { expect, test } from "bun:test";
import { blocksText } from "./text";

test("draft recipients read as a name and address, or the part supplied", () => {
  expect(
    blocksText([
      {
        kind: "Draft",
        context: [
          {
            label: "To",
            value: [{ name: "Ruth", address: "ruth@example.test" }, { name: "Ruth" }, { address: "ruth@example.test" }, { name: "A < B" }],
          },
        ],
        fields: [],
      },
    ]),
  ).toBe("To: Ruth <ruth@example.test>, Ruth, ruth@example.test, A < B");
});

test("long recipient text finishes within the isolated formatting budget", () => {
  // Measure formatting after imports; the subprocess timeout separately bounds startup and synchronous work.
  const run = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import { blocksText } from ${JSON.stringify(new URL("./text.ts", import.meta.url).pathname)};
    const name = "<a".repeat(100_000) + "\\nx";
    const start = performance.now();
    const result = blocksText([{ kind: "Draft", context: [{ label: "To", value: [{ name }] }], fields: [] }]);
    if (result !== "To: " + name) throw new Error("Recipient text changed");
    if (performance.now() - start > 500) throw new Error("Formatting exceeded its 500 ms budget");
    console.log("formatted");
  `,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 15_000 },
  );
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toBe("formatted\n");
}, 20_000);
