import type { RecordQuery } from "../contracts";
import type { Field } from "../service/types";
import type { DslFormulaAggregation } from "./resolver-aggregates";

export type DslTableSource = {
  kind: "table";
  id: string;
  shortId: string;
  name: string;
};

export type DslViewSource = {
  kind: "view";
  id: string;
  shortId: string;
  name: string;
  tableId: string;
  source?: string;
  query: RecordQuery;
  /** Keep an authorized source discoverable without broadening an unsupported saved scope. */
  unavailableReason?: "having" | "offset";
  /** Grouped formula outputs are supported as summary joins, not editable RecordQuery sources. */
  summaryFormulaAggregations?: DslFormulaAggregation[];
};

export type DslResolverContext = {
  documentMetadata?: boolean;
  currentTable?: DslTableSource;
  tables: DslTableSource[];
  views?: DslViewSource[];
  fieldsByTableId: Record<string, Field[]>;
};
