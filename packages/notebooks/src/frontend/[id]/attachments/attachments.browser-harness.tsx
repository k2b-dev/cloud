import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { Attachment } from "../_components/editor/attachments-client";
import { NOTES_NOW, notesContext, sampleNotes } from "../notes/notes-list.fixture";
import AttachmentsScreen from "./AttachmentsScreen";

/**
 * The attachments page for a browser test, rendered as the server would for its address: `?search=` filters the
 * invented sample by name. `data-sample="worst"` adds long names and many files.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const at = (hoursAgo: number) => new Date(Date.parse(NOTES_NOW) - hoursAgo * 3_600_000).toISOString();
const file = (id: string, filename: string, mimeType: string, sizeBytes: number, hoursAgo: number): Attachment => ({
  id,
  kind: mimeType.startsWith("image/") ? "image" : "file",
  filename,
  notebookId: "Lager1",
  mimeType,
  sizeBytes,
  createdBy: null,
  createdAt: at(hoursAgo),
});
const ATTACHMENTS: Attachment[] = [
  file("Att001", "Lageplan_Halle_2.pdf", "application/pdf", 482_311, 2),
  file("Att002", "Palettenregal.jpg", "image/jpeg", 2_311_004, 5),
  file("Att003", "Inventur_2026.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 88_120, 26),
  file("Att004", "Tourenplan.csv", "text/csv", 2_048, 50),
  file("Att005", "Sicherheitsunterweisung.md", "text/markdown", 3_120, 120),
];
const worst: Attachment[] = [
  file("Att900", "Statikberechnungsnachweisprüfungsergebnisprotokoll_final_v12_wirklich_final_neu_2.pdf", "application/pdf", 9_999_999, 1),
  file("Att901", "a", "application/octet-stream", 0, 3),
  ...ATTACHMENTS,
];
const all = document.documentElement.dataset.sample === "worst" ? worst : ATTACHMENTS;
const search = new URLSearchParams(location.search).get("search") ?? "";
const shown = all.filter((attachment) => attachment.filename.toLowerCase().includes(search.toLowerCase()));

render(
  () => (
    <LocaleProvider locale="de">
      <AttachmentsScreen
        ctx={notesContext(sampleNotes())}
        attachments={shown}
        total={shown.length}
        search={search}
        page={1}
        pages={1}
        baseHref="/app/notebooks/Lager1/attachments"
        graphBack={`${location.pathname}${location.search}`}
        now={NOTES_NOW}
      />
    </LocaleProvider>
  ),
  host,
);
