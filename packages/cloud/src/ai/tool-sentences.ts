import type { CapabilityPresentationCatalog } from "../contracts/capabilities";

/**
 * Sentences for Cloud's own Assistant tools that act on something, in the catalog shape every app uses for
 * its Actions and keyed by tool name. The chat words these calls through the same renderer as app Actions;
 * a test checks every placeholder against the tool's input schema.
 */
export const CLOUD_AI_TOOL_PRESENTATION = {
  baseLocale: "en",
  sentences: {
    // Code asks for approvals of what it does inside the run, so a rejection or a stop does not mean the code did not run.
    code_run: { approval: "Run code", done: "Ran code" },
    code_action: { approval: "Run app action {input.action}", done: "Ran app action {input.action}" },
    web_extract: { approval: "Read {input.url}", done: "Read {input.url}", notRun: "{input.url} not read" },
    fetch_file: { approval: "Download {input.url}", done: "Downloaded {input.url}", notRun: "{input.url} not downloaded" },
    write_file: { approval: "Write {input.path}", done: "Wrote {input.path}", notRun: "{input.path} not written" },
    memory: { approval: "Use memory", done: "Used memory", notRun: "Memory not used" },
  },
  translations: {
    de: {
      actions: {
        code_run: { sentences: { approval: "Code ausführen", done: "Code ausgeführt" } },
        code_action: { sentences: { approval: "App-Aktion {input.action} ausführen", done: "App-Aktion {input.action} ausgeführt" } },
        web_extract: { sentences: { approval: "{input.url} lesen", done: "{input.url} gelesen", notRun: "{input.url} nicht gelesen" } },
        fetch_file: {
          sentences: {
            approval: "{input.url} herunterladen",
            done: "{input.url} heruntergeladen",
            notRun: "{input.url} nicht heruntergeladen",
          },
        },
        write_file: {
          sentences: { approval: "{input.path} schreiben", done: "{input.path} geschrieben", notRun: "{input.path} nicht geschrieben" },
        },
        memory: {
          sentences: { approval: "Gedächtnis nutzen", done: "Gedächtnis genutzt", notRun: "Gedächtnis nicht genutzt" },
        },
      },
    },
  },
} as const satisfies CapabilityPresentationCatalog;
