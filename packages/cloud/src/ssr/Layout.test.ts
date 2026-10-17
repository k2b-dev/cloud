import { describe, expect, it } from "bun:test";
import { appAppearanceStyle, resolveCurrentApp } from "./app-appearance";
import type { RuntimeContext } from "./runtime";

const apps = [
  {
    id: "core",
    name: "Core",
    icon: "ti ti-cloud",
    description: "Core",
    routes: ["/"],
  },
  {
    id: "assistant",
    name: "Assistant",
    icon: "ti ti-sparkles",
    description: "Assistant",
    routes: ["/app/assistant"],
    appearance: {
      accent: "#14b8a6",
      background: { from: "#14b8a6", to: "#3b82f6", angle: 135 },
    },
  },
] satisfies RuntimeContext["apps"];

describe("app appearance layout helpers", () => {
  it("resolves the most specific app route", () => {
    expect(resolveCurrentApp(apps, "/app/assistant/chats")?.id).toBe("assistant");
    expect(resolveCurrentApp(apps, "/auth/login")?.id).toBe("core");
  });

  it("uses a neutral middle stop and emits safe gradient variables", () => {
    expect(appAppearanceStyle(undefined)).toBeUndefined();
    expect(appAppearanceStyle(apps[1]!.appearance)).toBe(
      "--app-accent:#14b8a6;--app-ink-light:#0d796e;--app-ink-dark:#14b8a6;--app-selected-light:#effaf9;--app-selected-dark:#112c2e;--app-selected-nav-light:#e1f2f0;--app-selected-nav-dark:#163537;--app-canvas-from:#14b8a6;--app-canvas-via:#ffffff;--app-canvas-to:#3b82f6;--app-canvas-angle:135deg;--app-canvas-strength:20%;--app-canvas-dark-strength:10%",
    );
    expect(appAppearanceStyle({ accent: "not-css" as "#invalid" })).toBeUndefined();
  });

  it("supports an optional middle gradient stop", () => {
    expect(
      appAppearanceStyle({
        accent: "#0369a1",
        background: { from: "#3b82f6", via: "#ffffff", to: "#facc15", angle: 135, strength: 12 },
      }),
    ).toContain(
      "--app-canvas-via:#ffffff;--app-canvas-to:#facc15;--app-canvas-angle:135deg;--app-canvas-strength:12%;--app-canvas-dark-strength:6%",
    );
  });

  it("clamps custom canvas strength", () => {
    expect(appAppearanceStyle({ accent: "#0369a1", background: { from: "#3b82f6", strength: 200 } })).toContain(
      "--app-canvas-strength:100%;--app-canvas-dark-strength:50%",
    );
  });
});
