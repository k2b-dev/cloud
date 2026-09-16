import { describe, expect, test } from "bun:test";

describe("App actions", () => {
  test("uses document navigation for SSR pages", async () => {
    const source = await Bun.file(new URL("./Actions.island.tsx", import.meta.url)).text();

    expect(source).not.toContain('navigation="enhanced"');
    expect(source).toContain("window.location.replace(navigateAction.href)");
  });

  test("reports the scoped workflow outcome instead of only its acceptance", async () => {
    const source = await Bun.file(new URL("./Actions.island.tsx", import.meta.url)).text();
    const client = await Bun.file(new URL("./workflow-action-client.ts", import.meta.url)).text();

    expect(source).toContain("invokeCustomAppWorkflow");
    expect(source).not.toContain("Workflow started.");
    expect(source).toContain("window.location.reload()");
    expect(client).toContain("started.statusUrl");
    expect(client).toContain('status.status === "succeeded"');
    expect(client).toContain('status.status === "failed"');
  });

  test("uses the shared prompt for workflow confirmation", async () => {
    const source = await Bun.file(new URL("./Actions.island.tsx", import.meta.url)).text();

    expect(source).toContain("prompts.confirm");
    expect(source).not.toContain("window.confirm");
  });
});
