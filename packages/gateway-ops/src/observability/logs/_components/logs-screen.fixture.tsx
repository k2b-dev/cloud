import { LocaleProvider } from "@k2b/ui";
import { logSearchOf, logsQuery, parseLogsAddress } from "../query";
import LogsScreen from "./LogsScreen";
import { FIXTURE_NOW, FIXTURE_TIME_ZONE, FIXTURE_TODAY, fixtureArea, fixtureEntries, fixtureSearch } from "./logs-fixture-data";

/** The screen for one address, as the page renders it: `state` "loadfail" stands for a log store that does not answer. */
export const LogsScreenFixture = (props: { search: string; locale?: string; state?: "normal" | "loadfail" }) => {
  const locale = props.locale ?? "de";
  const query = logsQuery(locale);
  const address = parseLogsAddress(query, new URLSearchParams(props.search), FIXTURE_NOW);
  const failed = props.state === "loadfail";
  const data = failed ? null : fixtureSearch(logSearchOf(address.state, FIXTURE_NOW), address.page);
  const open = address.entry ? (fixtureEntries.find((entry) => entry.id === address.entry) ?? null) : null;
  return (
    <LocaleProvider locale={locale}>
      <LogsScreen
        timeZone={FIXTURE_TIME_ZONE}
        today={FIXTURE_TODAY}
        area={fixtureArea}
        state={address.state}
        page={address.page}
        entry={address.entry}
        liveOff={address.liveOff}
        ignored={address.issues.length ? `Nicht angewendet: ${address.issues.map((issue) => `${issue.param}=${issue.value}`).join(", ")}. Die Liste zeigt den Rest.` : null}
        data={data}
        error={failed ? "Der Protokollspeicher antwortet nicht." : null}
        selected={address.entry ? { entry: open, error: null } : null}
      />
    </LocaleProvider>
  );
};
