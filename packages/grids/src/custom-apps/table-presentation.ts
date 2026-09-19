import type { CustomAppTablePresentation } from "./contracts";

type Column = { key: string; label: string; fieldId?: string; sqlType: string };

/** Presentation can only name columns already present in the authorized result. */
export function customAppTablePresentationIssues(
  presentation: CustomAppTablePresentation,
  columns: readonly Column[],
  reference: "field" | "label",
): Array<{ code: "records.presentation_column" | "records.relative_date_type"; path: Array<string | number> }> {
  const available = new Map<string, Column>();
  const ambiguous = new Set<string>();
  for (const column of columns) {
    const id = reference === "field" ? column.fieldId : column.label;
    if (!id) continue;
    if (available.has(id)) ambiguous.add(id);
    available.set(id, column);
  }
  for (const id of ambiguous) available.delete(id);
  const issues: ReturnType<typeof customAppTablePresentationIssues> = [];
  for (const [index, id] of (presentation.relativeDateColumnIds ?? []).entries()) {
    const column = available.get(id);
    if (!column || column.sqlType !== "date")
      issues.push({
        code: column ? "records.relative_date_type" : "records.presentation_column",
        path: ["relativeDateColumnIds", index],
      });
  }
  if (presentation.mobile) {
    if (!available.has(presentation.mobile.titleColumnId))
      issues.push({ code: "records.presentation_column", path: ["mobile", "titleColumnId"] });
    for (const [index, id] of presentation.mobile.detailColumnIds.entries()) {
      if (!available.has(id)) issues.push({ code: "records.presentation_column", path: ["mobile", "detailColumnIds", index] });
    }
  }
  return issues;
}
