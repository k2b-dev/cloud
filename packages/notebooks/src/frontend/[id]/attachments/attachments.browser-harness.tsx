import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { Attachment } from "../_components/editor/attachments-client";
import { NOTES_NOW, notesContext, sampleNotes } from "../notes/notes-list.fixture";
import AttachmentsScreen from "./AttachmentsScreen";

/**
 * The attachments page for a browser test, rendered as the server would for its address: `?search=` filters the
 * invented sample by name. `data-sample="worst"` adds long names and many files, `empty` shows none.
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
  file("Att006", "Rampe_Nord_Schaden.jpg", "image/jpeg", 3_870_512, 140),
  file("Att007", "Lieferschein_Brandt_4471.pdf", "application/pdf", 210_440, 170),
  file("Att008", "Stapler_Wartungsprotokoll.pdf", "application/pdf", 1_204_118, 220),
  file("Att009", "Hallenplan_2027.png", "image/png", 942_300, 260),
  file("Att010", "Preisliste_Haendler.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 56_210, 330),
  file("Att011", "Schulung_Scanner.mp4", "video/mp4", 48_200_000, 410),
  file("Att012", "Vertrag_Reinigung.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 120_330, 520),
  file("Att013", "Fotos_Inventur.zip", "application/zip", 22_400_100, 700),
  file("Att014", "Notfallplan_Aushang.pdf", "application/pdf", 640_002, 900),
];
const worst: Attachment[] = [
  file("Att900", "Statikberechnungsnachweisprüfungsergebnisprotokoll_final_v12_wirklich_final_neu_2.pdf", "application/pdf", 9_999_999, 1),
  file("Att901", "a", "application/octet-stream", 0, 3),
  file("Att902", "報告書_最終版_倉庫管理システム.pdf", "application/pdf", 1_234_567, 4),
  file("Att903", "📸 Rampe Süd.jpeg", "image/jpeg", 2_147_483_647, 6),
  file("Att904", "bartholomew.fitzgerald@northwind-industries-holdings.example.com.vcf", "text/vcard", 512, 24 * 400),
  ...ATTACHMENTS,
];
const sample = document.documentElement.dataset.sample;
const all = sample === "empty" ? [] : sample === "worst" ? worst : ATTACHMENTS;
const search = new URLSearchParams(location.search).get("search") ?? "";
// uploads per day in the 30 days up to now, from the sample's own dates (the server counts them the same way)
const DAY = 86_400_000;
const uploads = Array.from({ length: 30 }, (_, index) => {
  const end = Date.parse(NOTES_NOW) - (29 - index) * DAY;
  return all.filter((attachment) => {
    const at = Date.parse(attachment.createdAt);
    return at <= end && at > end - DAY;
  }).length;
});
const shown = all.filter((attachment) => attachment.filename.toLowerCase().includes(search.toLowerCase()));

render(
  () => (
    <LocaleProvider locale="de">
      <AttachmentsScreen
        ctx={{ ...notesContext(sampleNotes()), attachmentCount: all.length }}
        attachments={shown}
        total={shown.length}
        figures={{
          days: uploads,
          count: all.length,
          bytes: all.reduce((sum, attachment) => sum + attachment.sizeBytes, 0),
          added: uploads.reduce((sum, value) => sum + value, 0),
        }}
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
