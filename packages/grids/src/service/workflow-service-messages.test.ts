import { describe, expect, test } from "bun:test";
import { preflightWorkflowHttp } from "./workflow-http-client";
import { workflowServiceMessages } from "./workflow-service-messages";

describe("workflow service messages", () => {
  test("keeps English and German complete and resolves regional German locales", () => {
    expect(workflowServiceMessages.check()).toEqual([]);
    expect(workflowServiceMessages.resolve(["de-CH"]).t.workflowNotFound).toBe("Workflow nicht gefunden");
  });

  test("localizes HTTP preflight failures without changing their stable code", async () => {
    const result = await preflightWorkflowHttp({ url: "http://127.0.0.1/internal", method: "GET", locale: "de-CH" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("BAD_INPUT");
    expect(result.error.message).toBe("Das Ziel der HTTP-Anfrage ist keine öffentliche Adresse");
  });
});
