import { describe, expect, test } from "bun:test";
import { deviceFilesProblem } from "./choice-limits";

const file = (name: string, size: number) => new File([new Uint8Array(size)], name);

describe("limits for files from this device", () => {
  test("the caller's maxFiles, maxBytes, and maxTotalBytes apply as to files from providers", () => {
    const two = [file("a.txt", 400), file("b.txt", 400)];
    expect(deviceFilesProblem(two, { multiple: true }, "en")).toBeUndefined();
    expect(deviceFilesProblem(two, { multiple: true, maxFiles: 1 }, "en")).toBe("At most 1 file");
    expect(deviceFilesProblem(two, {}, "en")).toBe("At most 1 file");
    expect(deviceFilesProblem(two, { multiple: true, maxBytes: 300 }, "en")).toStartWith("“a.txt” is too large, up to");
    expect(deviceFilesProblem(two, { multiple: true, maxTotalBytes: 700 }, "en")).toStartWith("Too large together, up to");
    expect(deviceFilesProblem(two, { multiple: true, maxTotalBytes: 300 }, "de")).toStartWith("„a.txt“ ist zu groß, höchstens");
    expect(deviceFilesProblem(two, { multiple: true, maxFiles: 2, maxTotalBytes: 800 }, "en")).toBeUndefined();
  });
});
