import { LocaleProvider } from "@k2b/ui";
import { opsCharts } from "../../_components/ops-chart";
import { fixtureArea, LONG } from "../../_components/services-fixture-area";
import { valkeyQuery } from "../query";
import ValkeyScreen from "./ValkeyScreen";

const PREFIXES: [string, number][] = [
  ["mail:session", 18_204],
  ["spaces:presence", 9_311],
  ["cloud:ratelimit", 4_120],
  ["notebooks:draft", 812],
];

/** Valkey from invented diagnostics; `worst` adds the longest prefix, huge numbers and every warning. */
export const ValkeyScreenFixture = (props: { search?: string; worst?: boolean; locale?: string }) => {
  const locale = props.locale ?? "de";
  const state = valkeyQuery(locale).parse(new URLSearchParams(props.search ?? "")).state;
  const rows: [string, number][] = props.worst ? [[LONG, 9_999_999_999], ...PREFIXES] : PREFIXES;
  const chart = opsCharts(
    [
      {
        kind: "bar",
        title: "Präfixverteilung",
        description: "4.000 von 32.447 Schlüsseln als Stichprobe.",
        data: rows.map(([label, value]) => ({ label, value })),
      },
    ],
    locale,
  )[0]!;
  return (
    <LocaleProvider locale={locale}>
      <ValkeyScreen
        area={fixtureArea}
        state={state}
        ignored={null}
        error={null}
        cells={[
          { icon: "key", label: "Schlüssel", value: props.worst ? "9.999.999.999" : "32.447", meta: "1.204 laufen ab" },
          { icon: "cpu", label: "Speicher", value: "812 MB", meta: "von 1 GB", tone: "warn" },
          {
            icon: "trash-x",
            label: "Verdrängt",
            value: props.worst ? "1.204.993" : "0",
            meta: "allkeys-lru",
            tone: props.worst ? "bad" : undefined,
          },
          { icon: "target-arrow", label: "Trefferquote", value: "97,2 %", meta: "41 Clients" },
        ]}
        warnings={
          props.worst
            ? [
                {
                  tone: "warn",
                  title: "Speicher fast voll",
                  text: "Valkey nutzt mehr als 85 % des erlaubten Speichers. Neue Schlüssel verdrängen alte.",
                },
              ]
            : []
        }
        chart={chart}
        sampled="4.000 von 32.447 Schlüsseln als Stichprobe."
        prefixes={rows.map(([prefix, count]) => ({
          key: prefix,
          prefix,
          depth: "2",
          count: count.toLocaleString("de-DE"),
          share: "12,4 %",
          href: `/admin/observability/valkey?depth=3&q=${prefix}`,
        }))}
      />
    </LocaleProvider>
  );
};

export default () => <ValkeyScreenFixture search="depth=2" />;
