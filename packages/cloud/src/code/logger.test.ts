import { expect, test } from "bun:test";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";

const source = `import { app, logger, type CodeLogStep } from "@k2b/cloud/code";
app.schedule({cron:"0 8 * * *",name:"read"}, async () => {
  const read: CodeLogStep = logger.step("Read", {icon:"file-text",description:"Read document"});
  const save = logger.step({label:"Save"});
  read.start(); logger.info("Information"); logger.warn("Warning"); logger.error("Error");
  read.succeed("Read it"); save.skip("Already saved");
}); export default app;`;

test("the public SDK and checker accept logger overloads and handles without capability calls", async () => {
  const sdk = generateCodeSdk([], { mode: "personal" });
  const checked = analyzeCode({ sdk, entry: "code.ts", files: { "code.ts": source.replace("@k2b/cloud/code", "@sdk") }, aiOperations: [] });
  expect(checked.diagnostics).toEqual([]);
  expect(checked.permissions).toEqual([]);
  expect(sdk.declarations).toContain("export declare const logger: CodeLogger");
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  const calls: unknown[] = [];
  const handle = { start() {}, succeed() {}, fail() {}, skip() {} };
  loaded.__codeSdk.bind({
    call: async () => {
      throw new Error("No capability call expected");
    },
    logger: {
      step: (...args: unknown[]) => {
        calls.push(args);
        return handle;
      },
      info: (text: string) => calls.push(["info", text]),
      warn: (text: string) => calls.push(["warn", text]),
      error: (text: string) => calls.push(["error", text]),
    },
  });
  expect(loaded.logger.step("Read", { icon: "file-text" })).toBe(handle);
  expect(loaded.logger.step({ label: "Save" })).toBe(handle);
  loaded.logger.info("hello");
  loaded.logger.warn("careful");
  loaded.logger.error("failed");
  expect(calls).toEqual([
    ["Read", { icon: "file-text" }],
    [{ label: "Save" }],
    ["info", "hello"],
    ["warn", "careful"],
    ["error", "failed"],
  ]);
});

test("logger is reserved as a built-in SDK export", async () => {
  const { sdkFixture } = await import("./sdk.test-fixture");
  const sdk = generateCodeSdk([sdkFixture("logger")], { mode: "personal" });
  expect(sdk.manifest.apps[0]!.exportName).toBe("_logger");
  expect(() => generateCodeSdk([{ ...sdkFixture(), sdkExportName: "logger" }], { mode: "personal" })).toThrow("Reserved SDK export name");
});
