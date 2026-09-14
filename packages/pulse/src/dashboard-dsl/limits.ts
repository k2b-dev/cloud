import type { PulseDashboardLayout, PulseDashboardRow, PulseDashboardSection } from "../contracts";

export const MAX_DASHBOARD_QUERIES = 36;

export const dashboardLayoutError = (layout: PulseDashboardLayout): string | null => {
  let queries = 0;
  if ((layout.description?.length ?? 0) > 1000) return "Dashboard description is too long";
  const rowsError = (rows: PulseDashboardRow[], depth: number): string | null => {
    if (rows.length > 24 || depth > 4) return "Dashboard containers exceed the supported size or depth";
    for (const row of rows) {
      if (row.cells.length > 12) return "A dashboard row supports at most 12 widgets";
      for (const widget of row.cells) {
        if ((widget.title?.length ?? 0) > 160 || (widget.description?.length ?? 0) > 500) return "Widget title or description is too long";
        if (widget.kind === "card") {
          const error = rowsError(widget.rows, depth + 1);
          if (error) return error;
        } else if (widget.kind === "markdown") {
          if (widget.markdown.length > 8000) return "Markdown widgets support at most 8000 characters";
        } else {
          queries++;
          if ("conditions" in widget && (widget.conditions?.length ?? 0) > 8) return "A widget supports at most 8 conditions";
        }
      }
    }
    return null;
  };
  const sectionError = (sections: PulseDashboardSection[], depth: number): string | null => {
    if (sections.length > (depth === 0 ? 24 : 12) || (depth > 3 && sections.length > 0))
      return "Dashboard sections exceed the supported size or depth";
    for (const section of sections) {
      if (section.title.length > 160 || (section.description?.length ?? 0) > 500) return "Section title or description is too long";
      const error = rowsError(section.rows, 0) ?? sectionError(section.sections ?? [], depth + 1);
      if (error) return error;
    }
    return null;
  };
  const error = sectionError(layout.sections, 0);
  if (error) return error;
  if (queries > MAX_DASHBOARD_QUERIES) return `A dashboard supports at most ${MAX_DASHBOARD_QUERIES} data widgets`;
  if ((layout.controls?.length ?? 0) > 24) return "A dashboard supports at most 24 controls";
  for (const control of layout.controls ?? []) {
    if (
      control.label.length > 160 ||
      control.variable.length > 80 ||
      control.defaultValue.length > 505 ||
      (control.options?.length ?? 0) > 100 ||
      control.options?.some((option) => option.length > 505)
    )
      return "Dashboard control exceeds the supported size";
  }
  return null;
};
