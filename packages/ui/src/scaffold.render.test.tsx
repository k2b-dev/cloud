import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const {
  AppOverview,
  Button,
  CodeDisplay,
  DataPanel,
  Pagination,
  NoticeCard,
  PanelDialog,
  Placeholder,
  ProgressBar,
  StatCell,
  StatGrid,
  StatusBadge,
  toast,
  Widget,
  WidgetStat,
  WidgetStatus,
} = await import("./index");

describe("@k2b/ui scaffold SSR", () => {
  test("renders the scoped placeholder contract", () => {
    const html = renderToString(() =>
      createComponent(Placeholder, {
        title: "No records",
        description: "Create the first record.",
        state: "empty",
        variant: "panel",
      }),
    );

    expect(html).toContain('class="k2b-placeholder');
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("No records");
  });

  test("renders accessible foundation controls", () => {
    const button = renderToString(() =>
      createComponent(Button, {
        loading: true,
        loadingLabel: "Saving",
        children: "Save",
      }),
    );

    expect(button).toContain('aria-busy="true"');
    expect(button).toContain("Saving");
  });

  test("renders semantic status surfaces", () => {
    const badge = renderToString(() => createComponent(StatusBadge, { tone: "ok", variant: "dot", label: "Healthy" }));
    const progress = renderToString(() => createComponent(ProgressBar, { label: "Readiness", value: 42 }));
    const notice = renderToString(() =>
      createComponent(NoticeCard, {
        title: "Package boundary",
        tone: "danger",
        detail: "No Cloud dependency.",
      }),
    );

    expect(badge).toContain('data-tone="ok"');
    expect(badge).toContain("Healthy");
    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain('aria-valuenow="42"');
    expect(notice).toContain('data-tone="danger"');
    expect(notice).toContain("No Cloud dependency.");
  });

  test("renders application composition without Cloud contracts", () => {
    const html = renderToString(() =>
      createComponent(AppOverview, {
        title: "Operations",
        subtitle: "Generic overview",
        icon: "ti ti-activity",
        get children() {
          return createComponent(AppOverview.Main, {
            title: "Runtime",
            get children() {
              return createComponent(DataPanel, {
                title: "Services",
                get children() {
                  return createComponent(StatGrid, {
                    columns: 2,
                    get children() {
                      return createComponent(StatCell, {
                        label: "Requests",
                        value: "12k",
                        tone: "blue",
                      });
                    },
                  });
                },
              });
            },
          });
        },
      }),
    );

    expect(html).toContain("k2b-app-overview__main");
    expect(html).toContain('class="k2b-paper k2b-data-panel');
    expect(html).toContain("k2b-data-panel");
    expect(html).toContain('data-columns="2"');
    expect(html).toContain("Requests");
  });

  test("renders the generic panel and widget families", () => {
    const panel = renderToString(() =>
      createComponent(PanelDialog, {
        get children() {
          return [createComponent(PanelDialog.Header, { title: "Details" }), createComponent(PanelDialog.Body, { children: "Body" })];
        },
      }),
    );
    const widget = renderToString(() =>
      createComponent(Widget, {
        title: "Health",
        get children() {
          return [
            createComponent(WidgetStatus, { title: "Operational", tone: "success" }),
            createComponent(WidgetStat, { label: "Checks", value: 42 }),
          ];
        },
      }),
    );

    expect(panel).toContain("k2b-panel-dialog__header");
    expect(panel).toContain("k2b-panel-dialog__body");
    expect(widget).toContain("k2b-widget-status");
    expect(widget).toContain("Operational");
    expect(widget).toContain("Checks");
  });

  test("renders code content on the server", () => {
    const code = renderToString(() => createComponent(CodeDisplay, { code: "const value = 1", language: "ts" }));

    expect(code).toContain("cd-k");
  });

  test("renders URL-first pagination", () => {
    const pagination = renderToString(() =>
      createComponent(Pagination, {
        currentPage: 2,
        totalPages: 5,
        baseUrl: "?page=",
      }),
    );

    expect(pagination).toContain('aria-current="page"');
    expect(pagination).toContain("?page=3");
  });

  test("returns a no-op toast handle without a DOM", () => {
    expect(globalThis.document).toBeUndefined();
    const handle = toast.success("Saved");
    expect(typeof handle.update).toBe("function");
    expect(typeof handle.dismiss).toBe("function");
    expect(() => handle.update("Updated")).not.toThrow();
    expect(() => handle.dismiss()).not.toThrow();
  });

  test("keeps the stylesheet free of global resets", () => {
    const css = readFileSync(resolve(import.meta.dir, "styles/index.css"), "utf8");

    expect(css).toContain('@reference "tailwindcss"');
    expect(css).not.toContain('@import "tailwindcss"');
    expect(css).not.toMatch(/(^|[},])\s*(html|body|:root)(?=[\s,{])/m);
  });
});
