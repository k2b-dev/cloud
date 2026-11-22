import { describe, it, expect, mock } from "bun:test";
import { copyToClipboard } from "./clipboard";

describe("copyToClipboard", () => {
  it("resolves on successful copy", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      writable: true,
      configurable: true,
    });

    await expect(copyToClipboard("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("passes through empty strings", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      writable: true,
      configurable: true,
    });

    await expect(copyToClipboard("")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("");
  });

  it("rejects and re-throws on clipboard failure", async () => {
    const error = new Error("NotAllowedError");
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: () => Promise.reject(error) } },
      writable: true,
      configurable: true,
    });

    try {
      await copyToClipboard("hello");
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      expect(e).toBe(error); // Same error object, not wrapped
      expect(e).toBeInstanceOf(Error);
    }
  });
});
