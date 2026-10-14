import { LocaleProvider } from "@k2b/ui";
import DatabaseTable from "../../src/frontend/_components/table/DatabaseTable";
import { fields, records } from "../../src/frontend/_components/table/database-table.fixture-data";

export default function DatabaseTableFixture() {
  return (
    <LocaleProvider locale="de">
      <DatabaseTable result={{ items: records, fields, nextCursor: null }} baseId="base" scrollClass="k2b-detail-trail" />
    </LocaleProvider>
  );
}
