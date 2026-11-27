import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { current, entry, hidden, snapshot } from "../../test/history-fixtures";
import type { ActivityEntry, ActivitySide } from "../activity-contracts";
import type { RunSnapshot } from "./workspace-state";

await import("../../test/solid-ssr-preload");
const { default: RunDetail } = await import("./RunDetail");

const record = (patch: Partial<ActivityEntry> = {}) =>
  entry({
    action: "item.move",
    via: "agent",
    before: snapshot("team/Old/Plan.pdf"),
    after: current("team/New/Plan.pdf"),
    execution: { requestId: "request-only", invocationId: "invocation-only", callingApp: "core", origin: "assistant" },
    ...patch,
  });
const show = (run: RunSnapshot, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(RunDetail, {
          run,
          env: { now: "2026-10-20T12:12:00.000Z", timeZone: "Europe/Berlin" },
          closeHref: "/app/filesv2?view=activity",
          onNavigate: () => {},
          onRetry: () => {},
        });
      },
    }),
  );
const render = (value: ActivityEntry, locale = "en") => show({ id: value.id, entry: value }, locale);

describe("the run beside Activity's list", () => {
  test("renders actor/delegation, action, recorded outcome, time and visible paths without a whole-run claim", () => {
    const html = render(record());
    for (const text of [
      "Execution in Files",
      "Assistant on behalf of Lukas Pohl",
      "Result in Files",
      "Completed",
      "Plan.pdf",
      // the places as the path names them, never the raw stored path
      "team › Old · then",
      "team › New",
    ])
      expect(html).toContain(text);
    expect(html).toContain('datetime="2026-10-20T12:12:00.000Z"');
    expect(html).not.toContain("team/Old/Plan.pdf");
    // the references are behind a closed disclosure, made only while it is open, so they are not in the first picture
    expect(html).toContain('data-k2-part="Disclosure"');
    expect(html).toContain("Source context and references");
    expect(html).not.toContain("request-only");
    expect(html).not.toContain("invocation-only");
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
  test("German copy names the run and a recorded place in the reader's words", () => {
    const html = render(record(), "de");
    expect(html).toContain("Ausführung in Dateien");
    expect(html).toContain("Ergebnis in Dateien");
    expect(html).toContain("team › Old · damals");
  });
  test("a run that is not there, or not to be seen, says so without any stored data", () => {
    const html = show({ id: record().id, problem: "missing" });
    expect(html).toContain("This run is not there, or you may not see it.");
    for (const value of ["Lukas Pohl", "Plan.pdf", "request-only"]) expect(html).not.toContain(value);
  });
  test("a run that could not be read offers to read it again, and its way back stays", () => {
    const html = show({ id: record().id, problem: "failed" });
    expect(html).toContain("This run could not be loaded. Activity stays as it is.");
    expect(html).toContain('href="/app/filesv2?view=activity"');
  });
});
