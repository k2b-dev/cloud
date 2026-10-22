import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { current, entry, env, hidden } from "./history-fixtures";

describe("Files execution navigation and disclosure", () => {
  if (isServer) {
    test.skip("requires the DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => cleanup());

  test("View run is a native Files link only for reader-projected execution context", async () => {
    const dom = createDomTestHarness();
    cleanup = () => dom.cleanup();
    const { LocaleProvider } = await import("@k2b/ui");
    const { HistoryRow } = await import("../src/frontend/ActivityView");
    const { executionUrl, historyExecutionHref } = await import("../src/frontend/execution-url");
    const value = entry({
      id: "30000000-0000-4000-8000-000000000003",
      action: "item.move",
      before: hidden,
      after: current("team/Plan.pdf"),
      execution: { invocationId: "not-a-run-id", requestId: "not-a-run-url", origin: "assistant", callingApp: "core" },
    });
    const [record, setRecord] = createSignal(value);
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <HistoryRow
            row={{ key: record().id, kind: "single", lead: record(), entries: [record()] }}
            env={{ ...env, executionHref: historyExecutionHref }}
            context="activity"
            dated={false}
            variant="detail"
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const link = dom.root.querySelector<HTMLAnchorElement>(`a[href="${executionUrl(value.id)}"]`);
    expect(link?.textContent).toBe("View run");
    expect(link?.target).toBe("");
    expect(link?.href).not.toContain("not-a-run");
    setRecord({ ...value, execution: undefined });
    expect(dom.root.querySelector(`a[href="${executionUrl(value.id)}"]`)).toBeNull();
  });

  test("details start collapsed, can open natively, and replacing the authorized record drops old references", async () => {
    const dom = createDomTestHarness();
    cleanup = () => dom.cleanup();
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: ExecutionDetails } = await import("../src/frontend/ExecutionDetails");
    const [record, setRecord] = createSignal(
      entry({
        action: "file.edit",
        after: current("team/Plan.pdf"),
        execution: { requestId: "old-request", invocationId: "old-invocation", origin: "assistant", callingApp: "core" },
      }),
    );
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <ExecutionDetails entry={record()} timeZone={env.timeZone} />
        </LocaleProvider>
      ),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const details = dom.root.querySelector("details");
    expect(details?.open).toBe(false);
    // The native details element remains usable without an island or a network read.
    if (!details) throw new Error("Missing source context disclosure");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("old-request");
    setRecord(
      entry({
        action: "file.edit",
        after: current("team/Other.pdf"),
        execution: { requestId: "new-request", invocationId: null, origin: null, callingApp: null },
      }),
    );
    expect(dom.root.textContent).toContain("Other.pdf");
    expect(dom.root.textContent).toContain("new-request");
    expect(dom.root.textContent).not.toContain("old-request");
    expect(dom.root.textContent).not.toContain("old-invocation");
    expect(dom.root.querySelector("button, form")).toBeNull();
  });
});
