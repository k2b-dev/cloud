import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { RecordDisplayConfig } from "../../../contracts";
import type { Field, GridRecord } from "../../../service";
import "../ssr-test-plugin";

const { RecordCardsView } = await import("./RecordCardsView");

const field = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Name",
  type: "text",
  config: {},
  position: 0,
  presentable: true,
  hideInTable: false,
} as Field;

const record = {
  id: "22222222-2222-4222-8222-222222222222",
  tableId: "33333333-3333-4333-8333-333333333333",
  data: { [field.id]: "Camera" },
} as GridRecord;

const displayConfig = { mode: "cards", cards: { fieldIds: [field.id] } } as RecordDisplayConfig;

const renderCards = (
  cardSize: "small" | "medium" | "large",
  selectedId?: string,
  options: { interactive?: boolean; actions?: boolean } = { interactive: true },
) =>
  renderToString(() =>
    createComponent(RecordCardsView, {
      items: [record],
      fields: [field],
      displayConfig,
      baseId: "44444444-4444-4444-8444-444444444444",
      tableId: record.tableId,
      cardSize,
      selectedId,
      onRecordClick: options.interactive ? () => undefined : undefined,
      renderActions: options.actions ? () => <button type="button">Reserve</button> : undefined,
    }),
  );

describe("RecordCardsView sizing", () => {
  test("exposes the selected card size to the app-owned grid contract", () => {
    expect(renderCards("small")).toContain('data-card-size="small"');
    expect(renderCards("medium")).toContain('data-card-size="medium"');
    expect(renderCards("large")).toContain('data-card-size="large"');
  });

  test("marks selected cards independently from hover styling", () => {
    const html = renderCards("medium", record.id);

    expect(html).toContain("grids-record-card");
    expect(html).toContain("grid px-3 pb-3 pt-0.5");
    expect(html).toContain("bg-[var(--k2b-surface-muted)]");
    expect(html).toContain("hover:bg-[var(--k2b-hover)] hover:shadow-xs");
    expect(html).not.toContain("grids-record-card paper");
    expect(html).toContain('data-selected="true"');
  });

  test("keeps navigation and action controls as siblings and permits read-only cards", () => {
    const interactive = renderCards("medium", undefined, { interactive: true, actions: true });
    const readOnly = renderCards("medium", undefined, { interactive: false, actions: false });

    expect(interactive).toContain("Open Camera");
    expect(interactive).toContain("Reserve");
    expect(interactive).toMatch(/aria-label="Open Camera"><\/button>[\s\S]*<footer[^>]*>[\s\S]*<button/);
    expect(readOnly).not.toContain("<button");
  });

  test("shows the shared focus ring when a card is reached by keyboard", () => {
    const button = renderCards("medium").match(/<button[^>]*aria-label="Open Camera"/)?.[0];

    expect(button).toContain("focus-visible:outline-none focus-visible:[box-shadow:var(--ui-focus)]");
  });

  test("keeps widths monotonic and the selected outline stable on hover", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../../../styles/app.css")).text();

    expect(css).toMatch(/\.grids-record-card-grid\s*\{[^}]*--grids-record-card-width:\s*13rem/);
    expect(css).toMatch(/data-card-size="small"[^}]*--grids-record-card-width:\s*10rem/);
    expect(css).toMatch(/data-card-size="large"[^}]*--grids-record-card-width:\s*16rem/);
    expect(css).toMatch(
      /\.grids-record-card\[data-selected="true"\],\s*\.grids-record-card\[data-selected="true"\]:hover\s*\{[^}]*outline:\s*1px solid var\(--ui-app-accent-border\)/,
    );
  });
});
