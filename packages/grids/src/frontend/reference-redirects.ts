// The in-app reference windows were retired with UI v2: their links open the Help topic that holds the same reference.
/** The Help topic of a former reference tab; the query language by default. */
export const REFERENCE_TOPICS: ReadonlyMap<string, string> = new Map([
  ["basics", "grids-overview"],
  ["datatypes", "grids-tables-fields"],
  ["tables", "grids-tables-fields"],
  ["formulas", "grids-formulas"],
  ["gql", "grids-gql"],
  ["examples", "grids-gql"],
  ["how-it-works", "grids-gql"],
  ["templates", "grids-documents-pdfs"],
  ["workflows", "grids-workflows"],
]);
export const helpTopicHref = (tab: string | undefined | null) => `/help/apps/grids/${REFERENCE_TOPICS.get(tab ?? "") ?? "grids-gql"}`;
