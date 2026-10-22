import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { current, entry, hidden, snapshot } from "../../test/history-fixtures";
import type { ActivityEntry, ActivitySide } from "../activity-contracts";
await import("../../test/solid-ssr-preload");
const { default: ExecutionDetails } = await import("./ExecutionDetails");

const record = (patch: Partial<ActivityEntry> = {}) =>
  entry({
    action: "item.move",
    via: "agent",
    before: snapshot("team/Old/Plan.pdf"),
    after: current("team/New/Plan.pdf"),
    execution: { requestId: "request-only", invocationId: "invocation-only", callingApp: "core", origin: "assistant" },
    ...patch,
  });
const render = (value: ActivityEntry, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(ExecutionDetails, { entry: value, timeZone: "Europe/Berlin" });
      },
    }),
  );

describe("one recorded execution effect", () => {
  test("renders actor/delegation, action, recorded outcome, time and visible paths without a whole-run claim", () => {
    const html = render(record());
    for (const text of [
      "Execution in Files",
      "Assistant on behalf of Lukas Pohl",
      "Result in Files",
      "Completed",
      "team/Old/Plan.pdf",
      "team/New/Plan.pdf",
      "source conversation is not available",
      "does not describe the outcome of the whole originating run",
    ])
      expect(html).toContain(text);
    expect(html).toContain('datetime="2026-10-20T12:12:00.000Z"');
    expect(html).toContain("Recorded path; this does not confirm its current location.");
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
    expect(html).toContain("request-only");
    expect(html).toContain("invocation-only");
    expect(html).not.toContain("/app/assistant");
    expect(html).not.toContain("/admin/");
  });
  test.each([
    ["pending", "Running"],
    ["unclear", "Outcome unclear"],
    ["failed", "Failed"],
    ["not_done", "Not done"],
  ] as const)("%s stays the recorded Files outcome", (state, label) => {
    const html = render(record({ state, finishedAt: null }));
    expect(html).toContain(label);
    expect(html).not.toContain("Completed");
  });
  test("hidden sides add neither details nor a hidden item count, and absent metadata stays absent", () => {
    const html = render(record({ before: hidden, execution: undefined, batchId: "private-batch" }));
    expect(html).not.toContain(">Before<");
    expect(html).not.toContain("team/Old");
    expect(html).not.toContain("private-batch");
    expect(html).not.toContain("Source context and references");
    expect(html).not.toContain("Request reference");
    expect(html).not.toContain("more items");
  });
  test("historical writer-controlled values render as text, including collapsed references", () => {
    const value = '<img src=x onerror="alert(1)">';
    const after: ActivitySide = {
      visibility: "full",
      source: "snapshot",
      name: value,
      path: value,
      root: "groups",
      baseId: null,
      publicBaseId: null,
      itemId: null,
      directory: false,
      size: null,
      revision: null,
    };
    const html = render(
      record({
        actor: { kind: "user", userId: "actor", name: value },
        after,
        execution: { requestId: value, invocationId: null, callingApp: null, origin: null },
      }),
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
  });
  test("German copy retains the same scope and unavailable source boundary", () => {
    const html = render(record(), "de");
    expect(html).toContain("Ausführung in Dateien");
    expect(html).toContain("Ergebnis in Dateien");
    expect(html).toContain("Quellkonversation ist über diesen Eintrag nicht verfügbar");
  });
});
