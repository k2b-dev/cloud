import { describe, expect, test } from "bun:test";
import { NOTIFICATIONS } from "./notifications";

describe("Grids workflow notification copy", () => {
  test("uses the immutable delivery locale with regional fallback", async () => {
    expect(await NOTIFICATIONS.workflowEmail.render({ subject: "Invoice", html: "<p>Ready</p>" }, { locale: "de-CH" })).toEqual({
      title: "Invoice",
      body: "Von einem Grids-Workflow gesendet.",
    });
  });

  test("keeps English as the compatibility default", async () => {
    expect(await NOTIFICATIONS.workflowEmail.render({ subject: "Invoice", html: "<p>Ready</p>" }, { locale: "en" })).toEqual({
      title: "Invoice",
      body: "Sent by a Grids workflow.",
    });
  });
});
