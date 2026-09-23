import { describe, expect, test } from "bun:test";
import { mermaidConfig } from "./mermaid";

describe("mermaidConfig", () => {
  test("keeps rendering strict and locks theme and security against author directives", () => {
    for (const dark of [false, true]) {
      const config = mermaidConfig({ dark });
      expect(config.securityLevel).toBe("strict");
      expect(config.theme).toBe("base");
      expect(config.look).toBe("classic");
      expect(config.secure).toEqual(
        expect.arrayContaining(["secure", "securityLevel", "theme", "themeVariables", "themeCSS", "htmlLabels"]),
      );
      expect(config.secure).not.toContain("layout");
    }
  });

  test("keeps dagre for the types Mermaid 12 moved to ELK", () => {
    const config = mermaidConfig({ dark: false });
    for (const type of ["flowchart", "class", "state", "er", "requirement"] as const) {
      expect(config[type]?.layout).toBe("dagre");
    }
    expect(config.layout).toBeUndefined();
  });

  test("uses full hex colors so Mermaid can derive shades in both themes", () => {
    for (const dark of [false, true]) {
      const variables = mermaidConfig({ dark }).themeVariables as Record<string, unknown>;
      expect(variables.darkMode).toBe(dark);
      for (const [key, value] of Object.entries(variables)) {
        if (key === "darkMode" || key === "fontFamily") continue;
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(variables.pie12).toBeDefined();
      expect(variables.cScale11).toBeDefined();
    }
  });
});
