import type { RecordQuery } from "../contracts";
import type { Field } from "../service/types";

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
};

export type DslResolverContext = {
  documentMetadata?: boolean;
  currentTable?: DslTableSource;
  tables: DslTableSource[];
  views?: DslViewSource[];
  fieldsByTableId: Record<string, Field[]>;
};
