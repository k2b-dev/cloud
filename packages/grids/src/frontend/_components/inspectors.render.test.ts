import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "./ssr-test-plugin";

const { default: GroupDetailPanel } = await import("./table/GroupDetailPanel");

function expectSharedPanel(html: string, key: string) {
  expect(html.match(/class="k2b-detail-panel__body"/g)).toHaveLength(1);
  expect(html).toContain("k2b-detail-panel__header");
  expect(html).toContain(`data-scroll-preserve="${key}"`);
  expect(html).not.toContain('class="detail-');
}

describe("Grids group inspector", () => {
  test("renders group aggregates as rows and search inside the shared scroll body", () => {
    const html = renderToString(() =>
      createComponent(GroupDetailPanel, {
        tableId: "table1",
        fields: [],
        query: {},
        groupBy: [],
        aggregations: [],
        bucket: { keys: [], values: { "*__count": 42 } },
        relationLabels: {},
        onClose: () => {},
        onOpenRecord: () => {},
      }),
    );
    expectSharedPanel(html, "grids-group-detail-table1-[]");
    // The group is the name; no type word stands above or below it.
    expect(html).not.toContain('class="k2b-detail-panel__kind"');
    expect(html).not.toContain("k2b-detail-panel__header-icon");
    expect(html).not.toContain("k2b-section__icon");
    expect(html).toContain("k2b-description-list");
    expect(html).toContain("42");
    expect(html).toContain("ti ti-search");
    expect(html).toContain('type="button"');
  });
});
