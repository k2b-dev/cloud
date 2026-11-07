import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import MailAdminWorkflowAi from "./MailAdminWorkflowAi.island";

export type WorkflowAiHarnessOptions = { locale: "en" | "de"; bodyMaxChars: number; unreadable: boolean };

declare global {
  interface Window {
    mountWorkflowAi: (options: WorkflowAiHarnessOptions) => void;
  }
}

// The section as the Mail admin page renders it from its server snapshot.
window.mountWorkflowAi = (options) => {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing harness root");
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <main class="app-rows min-w-0 flex-1 overflow-auto p-4">
          <MailAdminWorkflowAi bodyMaxChars={options.bodyMaxChars} unreadable={options.unreadable} />
        </main>
      </LocaleProvider>
    ),
    root,
  );
};
