import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { notesContext, sampleNotes } from "../../notes/notes-list.fixture";
import VersionsWorkspace from "./VersionsWorkspace";

declare global {
  interface Window {
    /** Mounts the version history as the page does; `open` is the version in the address. */
    mountVersionHistory: (locale: "en" | "de", isLocked: boolean, open: string | null) => void;
  }
}

const base = notesContext(sampleNotes(4));
const ctx = { ...base, notebook: { ...base.notebook, id: "Book01" } };
const person = (id: string, displayName: string, avatarHash: string | null) => ({ kind: "user" as const, id, displayName, avatarHash });

window.mountVersionHistory = (locale, isLocked, open) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = locale;
  render(
    () => (
      <LocaleProvider locale={locale}>
        <VersionsWorkspace
          ctx={ctx}
          noteId="Note01"
          noteTitle="Runbook"
          isLocked={isLocked}
          currentContentMd={"# Current content\n\nThe runbook as it is now."}
          dateConfig={{ locale, timeZone: "UTC" }}
          initialVersions={[
            {
              id: "Version01",
              noteId: "Note01",
              createdBy: null,
              createdAt: "2026-10-11T10:00:00.000Z",
              contributors: [
                person("00000000-0000-4000-8000-000000000002", "Jana Berger", "h1"),
                person("00000000-0000-4000-8000-000000000003", "Paul Wagner", null),
              ],
            },
            {
              id: "Version02",
              noteId: "Note01",
              createdBy: null,
              createdAt: "2026-10-10T10:00:00.000Z",
              contributors: [
                person("00000000-0000-4000-8000-000000000002", "Jana Berger", "h1"),
                person("00000000-0000-4000-8000-000000000003", "Paul Wagner", null),
                person("00000000-0000-4000-8000-000000000004", "Mira Schulz", null),
                person("00000000-0000-4000-8000-000000000005", "Tom Krüger", null),
              ],
            },
            { id: "Version03", noteId: "Note01", createdBy: null, createdAt: "2026-10-09T10:00:00.000Z" },
          ]}
          initialTotal={3}
          initialVersionId={open}
        />
      </LocaleProvider>
    ),
    host,
  );
};
