import { LocaleProvider } from "../src/intl/locale";
import { Bar, Button, HeadSearch, Input, List, Pane, Path, Row, StatusRow, Text, Workspace } from "../src/v2";

// A pane's head and its toolbar as one block, the head's search as its symbol, and a row's time beside its deed, as the
// test sets them up:
// - `path`: a head with a path, a search, two ghost buttons with words and "+", above a toolbar (a StatusRow): two rows
//   close together without a line between them, one line under the block; one row where the pane is wide;
// - `filled`: `path` with words in the search from the address, as the server sends them;
// - `withEnd`: `path` whose search has a filter at its end, as Mail's: it keeps its field;
// - `nested`: `path` whose search holds a plain search in its end: that one is no head search;
// - `longPath`: `path` with seven places, which fold into "…" where the pane is narrow and stand whole where it is wide;
// - `actions`: a head of actions only (a search), above the same toolbar: one row on every width;
// - `state`: a head above a plain `Bar` that says the state of an open entry: no toolbar, so no block; it keeps its line;
// - `workspace`: a workspace head of actions only (a search) above a pane with a toolbar and no head of its own, the
//   case DR's #4470 moves into the pane's first row;
// - `rows`: a list whose rows of one line carry a time, a deed, or both: every row keeps one height.
export type Kind = "path" | "filled" | "withEnd" | "nested" | "longPath" | "actions" | "state" | "workspace" | "rows";

const Status = () => (
  <StatusRow
    lead="13 Einträge"
    filters={
      <>
        <Button icon="plus">Filter</Button>
        <Button icon="arrows-sort">Name</Button>
      </>
    }
  />
);

const files = ["Angebote", "Aufmaß", "Fotos", "Budget 2027.xlsx", "Lieferplan.pdf", "Notizen.md"];

const Search = (props: { kind: Kind }) => (
  <HeadSearch
    label="Suchen"
    value={props.kind === "filled" ? "Angebot" : undefined}
    end={
      props.kind === "withEnd" ? (
        <Button variant="ghost" icon="filter" label="Filter der Suche" />
      ) : props.kind === "nested" ? (
        <Input type="search" label="Im Filter suchen" />
      ) : undefined
    }
  />
);

export const Fixture = (props: { kind: Kind }) => {
  const withPath = () => ["path", "filled", "withEnd", "nested", "longPath", "state"].includes(props.kind);
  const places = () =>
    props.kind === "longPath"
      ? [
          { label: "Alle Ablagen", href: "#alle" },
          { label: "Werkstatt", href: "#werkstatt" },
          { label: "Lager Nord", href: "#lager" },
          { label: "Angebote", href: "#angebote" },
          { label: "Kunden 2027", href: "#kunden" },
          { label: "Ausschreibung", href: "#ausschreibung" },
          { label: "Lieferplan Frühjahr" },
        ]
      : [{ label: "Alle Ablagen", href: "#alle" }, { label: "Werkstatt" }];
  return (
    <LocaleProvider locale="de">
      <Workspace head={props.kind === "workspace" ? <Bar end={<Search kind={props.kind} />} /> : undefined}>
        <Pane
          label="Dateien"
          head={
            props.kind === "rows" || props.kind === "workspace" ? undefined : (
              <Bar
                start={withPath() ? <Path label="Ort" items={places()} /> : undefined}
                end={
                  <>
                    <Search kind={props.kind} />
                    {withPath() && props.kind !== "state" ? (
                      <>
                        <Button variant="ghost" icon="share">
                          Teilen
                        </Button>
                        <Button variant="ghost" icon="download">
                          Laden
                        </Button>
                        <Button variant="ghost" icon="plus" label="Neu" />
                      </>
                    ) : undefined}
                  </>
                }
              />
            )
          }
          status={
            props.kind === "rows" ? undefined : props.kind === "state" ? (
              <Bar start={<Text>3 Nachrichten · Wartet auf Antwort</Text>} />
            ) : (
              <Status />
            )
          }
        >
          <List label="Einträge">
            {files.map((name, index) => (
              <Row
                icon="file"
                lines={[name]}
                time={index === 1 ? undefined : `heute, 0${index}:40`}
                action={index < 2 ? { label: "Wiederherstellen", icon: "arrow-back-up", onClick: () => {} } : undefined}
              />
            ))}
          </List>
        </Pane>
      </Workspace>
    </LocaleProvider>
  );
};
