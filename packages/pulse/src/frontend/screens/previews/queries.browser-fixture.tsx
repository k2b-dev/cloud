import { LocaleProvider } from "@k2b/ui";
import { fixtureBases, fixtureQueries } from "../fixtures";
import QueriesScreen from "../QueriesScreen";

/** The saved queries of a base, for `v2-preview`. */
export default () => (
  <LocaleProvider locale="de">
    <QueriesScreen
      bases={fixtureBases}
      baseId={fixtureBases[0]!.id}
      sourceCount={4}
      page={{ items: fixtureQueries, total: 63, nextOffset: 50 }}
      offset={0}
      dateConfig={{ timeZone: "Europe/Berlin", locale: "de" }}
    />
  </LocaleProvider>
);
