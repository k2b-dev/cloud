import { expect, spyOn, test } from "bun:test";
import { CODE_CHECK_LIMITS } from "@k2b/cloud/code";
import { readCodeCheckLimits } from "./runner-jobs";
import { CODE_SETTINGS, codeSettings } from "./settings";

const memory = CODE_SETTINGS["core.code.runner_process_memory_bytes"];
for (const processMemory of [memory.min, memory.default, memory.max])
  test(`authoring check memory stays independent of a ${processMemory}-byte runtime process budget`, async () => {
    const settings = spyOn(codeSettings, "get").mockImplementation(async (key) =>
      key === "core.code.runner_process_memory_bytes" ? processMemory : CODE_SETTINGS[key].default,
    );
    try {
      expect((await readCodeCheckLimits()).memoryBytes).toBe(CODE_CHECK_LIMITS.memoryBytes);
      expect(settings.mock.calls.some(([key]) => key === "core.code.runner_process_memory_bytes")).toBe(false);
    } finally {
      settings.mockRestore();
    }
  });

test("authoring checks retain configured source, bundle, file and time ceilings", async () => {
  const settings = spyOn(codeSettings, "get").mockResolvedValue(1);
  try {
    expect(await readCodeCheckLimits()).toEqual({
      ...CODE_CHECK_LIMITS,
      sourceBytes: 1,
      bundleBytes: 1,
      files: 1,
      checkMs: 1,
    });
  } finally {
    settings.mockRestore();
  }
});
