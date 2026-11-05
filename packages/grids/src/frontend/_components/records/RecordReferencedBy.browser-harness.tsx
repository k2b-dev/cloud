import { DetailPanel, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { RecordLinks } from "./RecordReferencedBy";

/** The record's Links section with invented data; the test serves the reverse relations late, on purpose. */
declare global {
  interface Window {
    /**
     * `server`: the record's detail with its first page is there at once (SSR). `late-detail`: the detail arrives
     * after a moment, as when another record is opened in the browser. `browser`: the detail came without a page.
     */
    mountLinks: (mode: "server" | "late-detail" | "browser") => void;
  }
}

const reference = (id: string, label: string) => ({
  sourceTableId: "TABLE2",
  sourceTableName: "Ausleihen",
  sourceRecordId: id,
  sourceRecordLabel: label,
  relationFieldId: "FIELD2",
  relationFieldName: "Lagerort",
});
const serverPage = { items: [reference("REC101", "Ausleihe 101"), reference("REC102", "Ausleihe 102")], nextCursor: null };

window.mountLinks = (mode) => {
  const root = document.getElementById("root")!;
  root.textContent = "";
  const [ready, setReady] = createSignal(mode !== "late-detail");
  if (mode === "late-detail") setTimeout(() => setReady(true), 400);
  render(
    () => (
      <LocaleProvider locale="de">
        <DetailPanel>
          <DetailPanel.Body>
            <RecordLinks
              baseId="BASE01"
              tableId="TABLE1"
              recordId="REC001"
              outgoing={[
                { id: "out-1", title: "Kategorie · Kameras", icon: "ti ti-link", href: "/app/grids/BASE01/table/CAT001?record=CAT001" },
                { id: "out-2", title: "Regal · Studio", icon: "ti ti-link", href: "/app/grids/BASE01/table/SHELF1?record=SHELF1" },
              ]}
              ready={ready()}
              initialPage={mode === "browser" ? null : serverPage}
            />
          </DetailPanel.Body>
        </DetailPanel>
      </LocaleProvider>
    ),
    root,
  );
};

export type LinksHarnessMount = Window["mountLinks"];
