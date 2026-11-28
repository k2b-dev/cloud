import { LocaleProvider } from "../src/intl/locale";
import { Bar, Button, Input, List, Pane, Path, Row, StatusRow, Text, Workspace } from "../src/v2";

// A pane's head and its status row as one block, and a row's time beside its deed, as the test sets them up:
// - `path`: a head with a path, a search and "+", above a status row with a filter and how the list shows: two rows
//   close together without a line between them, one line under the block; one row where the pane is wide;
// - `actions`: a head of actions only (a search), above the same status row: one row on every width;
// - `rows`: a list whose rows of one line carry a time, a deed, or both: every row keeps one height.
// - `state`: a head above a plain `Bar` that says the state of an open entry: no toolbar, so no block; it keeps its line.
export type Kind = "path" | "actions" | "rows" | "state";

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

export const Fixture = (props: { kind: Kind }) => (
  <LocaleProvider locale="de">
    <Workspace>
      <Pane
        label="Dateien"
        head={
          props.kind === "rows" ? undefined : (
            <Bar
              start={
                props.kind === "path" || props.kind === "state" ? (
                  <Path label="Ort" items={[{ label: "Alle Ablagen", href: "#alle" }, { label: "Werkstatt" }]} />
                ) : undefined
              }
              end={
                <>
                  <Input type="search" icon="search" label="Suchen" placeholder="Suchen" />
                  {props.kind === "path" ? <Button variant="ghost" icon="plus" label="Neu" /> : undefined}
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
