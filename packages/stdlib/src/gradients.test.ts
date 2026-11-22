import { describe, it, expect } from "bun:test";
import { getGradientById, gradientPresets } from "./gradients";

describe("getGradientById", () => {
  it("returns preset for known id", () => {
    expect(getGradientById("ocean").label).toBe("Ocean");
  });

  it("returns default preset for unknown id", () => {
    expect(getGradientById("nonexistent").id).toBe("default");
  });

  it("returns default preset for empty string", () => {
    expect(getGradientById("").id).toBe("default");
  });
});

describe("gradientPresets", () => {
  it("is a non-empty array", () => {
    expect(gradientPresets.length).toBeGreaterThan(0);
  });

  it("every preset has required fields", () => {
    for (const preset of gradientPresets) {
      expect(typeof preset.id).toBe("string");
      expect(typeof preset.label).toBe("string");
      expect(typeof preset.style).toBe("string");
      expect(typeof preset.preview).toBe("string");
    }
  });

  it("has no duplicate ids", () => {
    const ids = gradientPresets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("first preset is 'default'", () => {
    expect(gradientPresets[0]!.id).toBe("default");
  });
});
