import { ButtonLink, DataTable, type DataTableColumn, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { CapabilitySemanticLinkSchema, CapabilityTablePresentationSchema, capabilityDataAtPath } from "../../contracts/capabilities";
import { aiChatMessages } from "./messages";

export const capabilityTable = (result: unknown) => {
  if (!result || typeof result !== "object") return null;
  const presentation = CapabilityTablePresentationSchema.safeParse(capabilityDataAtPath(result, ["presentation"]));
  if (!presentation.success) return null;
  const rows = capabilityDataAtPath(capabilityDataAtPath(result, ["data"]), presentation.data.rowsPath);
  if (!Array.isArray(rows)) return null;
  return { presentation: presentation.data, rows };
};

export const capabilityCellText = (value: unknown): string => {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "—";
};

export function CapabilityTablePreview(props: { result: unknown; label: string }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const table = createMemo(() => capabilityTable(props.result));
  const linksId = "row-links";
  const columns = createMemo<DataTableColumn<unknown>[]>(() => {
    const value = table();
    if (!value) return [];
    return [
      ...value.presentation.columns.map((column, index) => ({
        id: String(index),
        header: column.label,
        value: (row: unknown) => capabilityCellText(capabilityDataAtPath(row, column.path)),
        align: column.format === "number" ? ("right" as const) : ("left" as const),
      })),
      ...(value.presentation.rowLinksPath ? [{ id: linksId, header: t().tableLinks }] : []),
    ];
  });
  const rowLinks = (row: unknown) => {
    const path = table()?.presentation.rowLinksPath;
    const links = path ? capabilityDataAtPath(row, path) : undefined;
    return Array.isArray(links)
      ? links.slice(0, 20).flatMap((link) => {
          const parsed = CapabilitySemanticLinkSchema.safeParse(link);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  };
  return (
    <Show when={table()}>
      {(value) => (
        <div class="my-2 min-w-0 space-y-2">
          <DataTable
            rows={value().rows.slice(0, 100)}
            columns={columns()}
            density="compact"
            surface="plain"
            ariaLabel={props.label}
            class="max-h-80 overflow-auto"
            empty={<span>{t().tableEmpty}</span>}
            renderCell={({ row, col, value: cell }) =>
              col.id === linksId ? (
                <For each={rowLinks(row)}>
                  {(link) => (
                    <ButtonLink href={link.href} target="_blank" rel="noopener noreferrer" variant="ghost" size="xs">
                      {link.title ?? t().tableOpen}
                    </ButtonLink>
                  )}
                </For>
              ) : (
                <span class="block max-w-80 truncate" title={String(cell)}>
                  {String(cell)}
                </span>
              )
            }
          />
          <Show when={value().rows.length > 100}>
            <p class="text-sm text-secondary">{t().tableCapped}</p>
          </Show>
          <Show when={capabilityDataAtPath(props.result, ["page", "hasMore"]) === true}>
            <p class="text-sm text-secondary">{t().tableMore}</p>
          </Show>
        </div>
      )}
    </Show>
  );
}
