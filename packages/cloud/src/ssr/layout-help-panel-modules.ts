// Keep importOnDemand() from ../browser/reload out: its eager toast import would break the panel bundle budget.
export const helpPanelModules = {
  menu: () => import("./layout-help-panel-menu"),
  search: () => import("./layout-help-panel-search"),
  reader: () => import("./layout-help-panel-reader"),
  document: () => import("./layout-help-panel-document"),
};
