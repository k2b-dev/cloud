import { LocaleProvider } from "@k2b/ui";
import { fixtureBases, fixtureNav } from "../fixtures";
import SqlScreen from "../SqlScreen";

/** The SQL console with an empty draft, for `v2-preview`. */
export default () => (
  <LocaleProvider locale="de">
    <SqlScreen
      nav={fixtureNav()}
      baseName={fixtureBases[0]!.name}
      baseId={fixtureBases[0]!.id}
      sourceCount={4}
      route={{
        view: "sql",
        sourceId: "",
        sql: "SELECT ts AS time, value FROM samples WHERE name = :metric LIMIT 100",
        params: { metric: "cpu" },
      }}
      snapshot={{ limits: null, query: null, error: null }}
      canWrite
    />
  </LocaleProvider>
);
