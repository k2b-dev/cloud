import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import VersionHistory from "./VersionHistory.island";

declare global {
  interface Window {
    mountVersionHistory: (locale: "en" | "de", isLocked: boolean) => void;
  }
}

window.mountVersionHistory = (locale, isLocked) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = locale;
  render(
    () => (
      <LocaleProvider locale={locale}>
        <AppWorkspace mobileSurface="flush" class="notebooks-workspace flex-1 min-h-0">
          <AppWorkspace.Content>
            <AppWorkspace.Main scroll={false}>
              <VersionHistory
                notebookId="Book01"
                noteId="Note01"
                noteTitle="Runbook"
                isLocked={isLocked}
                currentContentMd="Current content"
                dateConfig={{ locale, timeZone: "UTC" }}
                initialVersions={[
                  { id: "Version01", noteId: "Note01", createdBy: null, createdAt: "2026-10-11T10:00:00.000Z" },
                  { id: "Version02", noteId: "Note01", createdBy: null, createdAt: "2026-10-10T10:00:00.000Z" },
                  { id: "Version03", noteId: "Note01", createdBy: null, createdAt: "2026-10-09T10:00:00.000Z" },
                ]}
                initialTotal={3}
              />
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </LocaleProvider>
    ),
    host,
  );
};
