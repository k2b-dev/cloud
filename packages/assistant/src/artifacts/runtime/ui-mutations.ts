import { UiNode } from "./protocol";
import { ChartOptions } from "./chart-schema";
import { z } from "zod";
const Key = z.union([z.string().min(1), z.number().finite()]);
function unique<T>(items: T[], key: (item: T) => string | number) {
  const keys = items.map(key);
  if (new Set(keys).size !== keys.length) throw new Error("Collection keys must be unique");
  return items;
}
function rowKey(n: UiNode, row: UiNode["rows"][number]) {
  if (!n.rowKey) throw new Error("Table upsert/remove(ids) requires rowKey");
  return Key.parse(row[n.rowKey]);
}
function commitList(n: UiNode, input: unknown) {
  const items = unique(UiNode.shape.items.parse(input), (item) => Key.parse(item.id));
  n.items = items;
  n.state = items.length ? "ready" : "empty";
}
function commitRows(n: UiNode, input: unknown) {
  const rows = UiNode.shape.rows.parse(input);
  if (n.rowKey) unique(rows, (row) => rowKey(n, row));
  n.rows = rows;
  n.state = rows.length ? "ready" : "empty";
}
export function setUiValue(n: UiNode, value: unknown) {
  if (n.kind === "list") commitList(n, value);
  else if (n.kind === "table") commitRows(n, value);
  else if (n.kind === "chart") n.chart = ChartOptions.parse(value);
  else if (n.kind === "progress") n.progress = UiNode.shape.progress.parse(value);
  else if (["input", "select", "markdown"].includes(n.kind)) {
    const next = UiNode.shape.value.parse(value);
    if (n.kind === "select" && !n.options.some((option) => option.value === next)) throw new Error("Unknown select value");
    n.value = next;
  } else if (["text", "status", "button", "link", "linkButton", "section"].includes(n.kind)) n.label = UiNode.shape.label.parse(value);
  else throw new Error("set is not supported for this UI element");
}
export function upsertUiItems(n: UiNode, input: unknown) {
  if (n.kind === "list") {
    const incoming = unique(UiNode.shape.items.parse(input), (item) => Key.parse(item.id));
    const items = new Map(n.items.map((item) => [item.id, item]));
    incoming.forEach((item) => items.set(item.id, item));
    commitList(n, [...items.values()]);
  } else if (n.kind === "table") {
    if (!n.rowKey) throw new Error("Table upsert requires rowKey");
    const incoming = unique(UiNode.shape.rows.parse(input), (row) => rowKey(n, row));
    const rows = new Map(n.rows.map((row) => [rowKey(n, row), row]));
    incoming.forEach((row) => rows.set(rowKey(n, row), row));
    commitRows(n, [...rows.values()]);
  } else throw new Error("upsert requires a list or table");
}
export function removeUiItems(n: UiNode, input?: unknown) {
  if (n.kind !== "list" && n.kind !== "table") throw new Error("remove requires a list or table");
  if (input === undefined) {
    setUiValue(n, []);
    return;
  }
  const ids = new Set(z.array(Key).parse(input));
  if (!ids.size) return;
  if (n.kind === "list")
    commitList(
      n,
      n.items.filter((item) => !ids.has(item.id)),
    );
  else {
    if (!n.rowKey) throw new Error("Table remove(ids) requires rowKey");
    commitRows(
      n,
      n.rows.filter((row) => !ids.has(rowKey(n, row))),
    );
  }
}
