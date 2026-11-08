import { chartTable } from "@k2b/editor/charts";
import { blockDataAtPath } from "./bind";
import type { Block } from "./schema";

type TextOptions = { locale?: string; timeZone?: string };
const plain = (value: unknown): string => (value == null ? "—" : String(value));
const quote = (value: string): string => JSON.stringify(value);

/** Plain text for terminals and MCP. The caller applies terminal control-character escaping. */
export function blocksText(blocks: readonly Block[], options: TextOptions = {}): string {
  const locale = options.locale ?? "en";
  const format = (
    value: unknown,
    hint?: { style?: "number" | "percent" | "currency"; currency?: string; decimals?: number; compact?: boolean; unit?: string },
    date?: string,
  ): string => {
    if ((date === "date" || date === "datetime") && typeof value === "string") {
      const parsed = new Date(value);
      if (Number.isFinite(parsed.getTime()))
        return new Intl.DateTimeFormat(locale, {
          timeZone: options.timeZone ?? "UTC",
          dateStyle: "medium",
          ...(date === "datetime" ? { timeStyle: "short" as const } : {}),
        }).format(parsed);
    }
    if (typeof value !== "number") return plain(value);
    const number = new Intl.NumberFormat(locale, {
      style: hint?.style === "number" ? "decimal" : hint?.style,
      currency: hint?.currency,
      minimumFractionDigits: hint?.decimals,
      maximumFractionDigits: hint?.decimals,
      notation: hint?.compact ? "compact" : "standard",
    }).format(value);
    return hint?.unit ? `${number} ${hint.unit}` : number;
  };
  const text = (node: Block): string => {
    switch (node.kind) {
      case "Section":
        return [node.title, node.description, ...node.children.map(text)].filter(Boolean).join("\n");
      case "Heading":
      case "Text":
        return node.text;
      case "Notice":
        return [node.title, node.text].filter(Boolean).join(": ");
      case "Link":
        return `${node.label}: ${node.href}`;
      case "Image":
        return [node.alt, node.caption, node.src].filter(Boolean).join("\n");
      case "Button":
      case "Action":
        return `${node.label}: ${node.action}`;
      case "Stats":
        return node.items
          .map(
            (item) =>
              `${item.label}: ${format(item.value, item.format)}${item.delta ? ` (${format(item.delta.value, item.delta.unit === "points" ? undefined : { style: "percent" })}${item.delta.unit === "points" ? " pp" : ""})` : ""}`,
          )
          .join("\n");
      case "Detail":
        return [
          node.title,
          ...node.items.map((item) => {
            const value =
              item.type === "status" ? (item.states?.[plain(item.value)]?.label ?? plain(item.value)) : format(item.value, item.format);
            const before =
              item.before === undefined
                ? ""
                : `${item.type === "status" ? (item.states?.[plain(item.before)]?.label ?? plain(item.before)) : format(item.before, item.format)} → `;
            return `${item.label}: ${before}${value}`;
          }),
        ].join("\n");
      case "Table":
        return [
          node.title,
          node.subtitle,
          node.columns.map((column) => column.label).join(" | "),
          ...node.rows.map((row) => {
            const cells = node.columns
              .map((column) => {
                const value = blockDataAtPath(row, column.path ?? [column.key!]);
                return column.type === "status"
                  ? (column.states?.[plain(value)]?.label ?? plain(value))
                  : format(value, column.format, column.type);
              })
              .join(" | ");
            const href = node.rowHref ? blockDataAtPath(row, node.rowHref) : undefined;
            return typeof href === "string" ? `${cells} | ${href}` : cells;
          }),
          node.rows.length === 0 ? (node.empty ?? "No rows.") : undefined,
        ]
          .filter(Boolean)
          .join("\n");
      case "Cards":
        return [
          node.title,
          ...node.items.map((item) => {
            const at = (path: string[] | undefined) => (path ? blockDataAtPath(item, path) : undefined);
            const badges = at(node.card.badges);
            return [
              plain(at(node.card.title)),
              at(node.card.subtitle),
              at(node.card.imageAlt),
              Array.isArray(badges) ? badges.join(", ") : undefined,
              ...(node.card.facts ?? []).map((fact) => `${fact.label}: ${plain(at(fact.value))}`),
              at(node.card.price),
              at(node.card.rating) === undefined ? undefined : `Rating: ${plain(at(node.card.rating))}`,
              at(node.card.href),
            ]
              .filter((value) => value !== undefined && value !== null)
              .join("\n");
          }),
          node.items.length === 0 ? (node.empty ?? "No items.") : undefined,
        ]
          .filter(Boolean)
          .join("\n");
      case "Choice":
        return [
          node.title,
          node.description,
          ...node.options.map(
            (option, i) =>
              `${i + 1}. ${plain(blockDataAtPath(option, node.option.title))} [${plain(blockDataAtPath(option, node.option.id))}]${node.option.subtitle ? ` — ${plain(blockDataAtPath(option, node.option.subtitle))}` : ""}`,
          ),
          node.submit,
        ]
          .filter(Boolean)
          .join("\n");
      case "Form":
      case "Draft":
        return [
          node.kind === "Form" ? node.title : undefined,
          ...(node.kind === "Draft"
            ? (node.context ?? []).map(
                (entry) =>
                  `${entry.label}: ${
                    typeof entry.value === "string"
                      ? entry.value
                      : entry.value
                          .map((person) =>
                            [person.name, person.address]
                              .filter(Boolean)
                              .join(" <")
                              .replace(/<(.+)$/, "<$1>"),
                          )
                          .join(", ")
                  }`,
              )
            : []),
          ...node.fields.map(
            (field) =>
              `${field.label}: ${plain(field.type === "select" ? (field.options?.find((option) => option.value === field.value)?.label ?? field.value) : field.value)}`,
          ),
        ]
          .filter(Boolean)
          .join("\n");
      case "Chart": {
        if (!node.description) return [node.title, node.empty].join("\n");
        const table = chartTable(node.description, locale);
        return [
          node.description.title,
          node.description.subtitle,
          table.columns.map((column) => column.label).join(" | "),
          ...table.rows.map((row) => table.columns.map((column) => row.cells[column.id] ?? "—").join(" | ")),
        ]
          .filter(Boolean)
          .join("\n");
      }
    }
  };
  return blocks.map(text).join("\n\n");
}

/** Short English metadata for the model. Labels and IDs remain untrusted quoted provider data. */
export function blocksSummary(blocks: readonly Block[]): string {
  const descriptions: string[] = [];
  const add = (node: Block): void => {
    if (node.kind === "Section") {
      node.children.forEach(add);
      return;
    }
    switch (node.kind) {
      case "Cards":
        descriptions.push(`cards ${quote(node.title)} (${node.items.length})`);
        break;
      case "Table":
        descriptions.push(`table (${node.rows.length} rows)`);
        break;
      case "Chart":
        descriptions.push(`chart ${quote(node.description?.title ?? node.title ?? "")}`);
        break;
      case "Choice":
        descriptions.push(
          `open choice ${quote(node.title)}: ${node.options.map((option) => quote(plain(blockDataAtPath(option, node.option.id)))).join(", ")}`,
        );
        break;
      case "Detail":
        descriptions.push(`details ${quote(node.title)}`);
        break;
      case "Stats":
        descriptions.push(`stats (${node.items.length})`);
        break;
      case "Image":
        descriptions.push(`image ${quote(node.alt)}`);
        break;
      case "Draft":
        descriptions.push(`draft (${node.fields.length} fields)`);
        break;
      case "Heading":
        descriptions.push(`heading ${quote(node.text)}`);
        break;
      case "Text":
        descriptions.push("text");
        break;
      case "Notice":
        descriptions.push(`notice ${quote(node.title)}`);
        break;
      case "Link":
        descriptions.push(`link ${quote(node.label)}`);
        break;
      case "Form":
        descriptions.push(`form ${quote(node.title)}`);
        break;
      case "Button":
      case "Action":
        descriptions.push(`button ${quote(node.label)}`);
        break;
    }
  };
  blocks.forEach(add);
  return descriptions.length ? `Shown: ${descriptions.join(", ")}` : "Shown: no blocks";
}
