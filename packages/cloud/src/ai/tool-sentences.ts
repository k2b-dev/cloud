import { actionReview } from "../capabilities/reviews";
import type { CapabilityActionCallReview } from "../contracts/capabilities";
import { CodeActionInput } from "./browser-code-contracts";

// Like the catalog these forms replace, code runs name no "not run" form: code asks about what it does inside the run,
// so a declined or stopped question does not mean the code did not run. No tool names a "rejected" form, so a declined
// call keeps Cloud's own words.
const forms = {
  en: {
    code_run: {
      action: "Run code",
      running: "Running code",
      done: "Ran code",
      confirm: "Run code",
      decline: "Do not run",
    },
    code_action: {
      action: "Run app action {action}",
      running: "Running app action {action}",
      done: "Ran app action {action}",
      confirm: "Run action",
      decline: "Do not run",
    },
    web_extract: {
      action: "Read page on {site}",
      running: "Reading page on {site}",
      done: "Read page on {site}",
      confirm: "Read page",
      decline: "Do not read",
      notRun: "Page on {site} not read",
    },
    fetch_file: {
      action: "Download file from {site}",
      running: "Downloading file from {site}",
      done: "Downloaded file from {site}",
      confirm: "Download file",
      decline: "Do not download",
      notRun: "File from {site} not downloaded",
    },
    write_file: {
      action: "Write {file}",
      running: "Writing {file}",
      done: "Wrote {file}",
      confirm: "Write file",
      decline: "Do not write",
      notRun: "{file} not written",
    },
  },
  de: {
    code_run: {
      action: "Code ausführen",
      running: "Code wird ausgeführt",
      done: "Code ausgeführt",
      confirm: "Code ausführen",
      decline: "Nicht ausführen",
    },
    code_action: {
      action: "App-Aktion {action} ausführen",
      running: "App-Aktion {action} wird ausgeführt",
      done: "App-Aktion {action} ausgeführt",
      confirm: "Aktion ausführen",
      decline: "Nicht ausführen",
    },
    web_extract: {
      action: "Seite auf {site} lesen",
      running: "Seite auf {site} wird gelesen",
      done: "Seite auf {site} gelesen",
      confirm: "Seite lesen",
      decline: "Nicht lesen",
      notRun: "Seite auf {site} nicht gelesen",
    },
    fetch_file: {
      action: "Datei von {site} herunterladen",
      running: "Datei von {site} wird heruntergeladen",
      done: "Datei von {site} heruntergeladen",
      confirm: "Datei herunterladen",
      decline: "Nicht herunterladen",
      notRun: "Datei von {site} nicht heruntergeladen",
    },
    write_file: {
      action: "{file} schreiben",
      running: "{file} wird geschrieben",
      done: "{file} geschrieben",
      confirm: "Datei schreiben",
      decline: "Nicht schreiben",
      notRun: "{file} nicht geschrieben",
    },
  },
} as const;

/** The bound of a `fields` preview value. */
const ADDRESS_MAX = 2000;
const readableAddress = (address: string): string | null => {
  try {
    return decodeURI(address);
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Cloud tools use the same per-call review contract as application Actions. Safe for historical, incomplete inputs. */
export const cloudToolReview = (name: string, args: unknown, locale: string): CapabilityActionCallReview | null => {
  if (!isRecord(args)) return null;
  const language = /^de(?:-|$)/i.test(locale) ? "de" : "en";
  const input = args;
  const sentence = forms[language];
  try {
    if (name === "code_run") {
      return actionReview({ locale: language, sentence: sentence.code_run }, {});
    }
    if (name === "code_action") {
      const parsed = CodeActionInput.shape.action.safeParse(input.action);
      if (!parsed.success) return null;
      return actionReview({ locale: language, sentence: sentence.code_action }, { action: { kind: "text", value: parsed.data } });
    }
    if (name === "web_extract" || name === "fetch_file") {
      if (typeof input.url !== "string" || !input.url.trim()) return null;
      const url = new URL(input.url);
      if (!url.host) return null;
      const review = (address: string) =>
        actionReview(
          { locale: language, sentence: sentence[name] },
          { site: { kind: "place", title: url.host } },
          { preview: { kind: "fields", rows: [{ label: language === "de" ? "Adresse" : "Address", value: address }] } },
        );
      // The address row holds at most 2,000 characters. An address whose encoded form is longer shows as written,
      // and only if even that does not fit is it cut in the middle; the question asks either way.
      for (const address of [input.url, readableAddress(input.url)])
        if (address && address.length <= ADDRESS_MAX) {
          try {
            return review(address);
          } catch {
            // Try the next form.
          }
        }
      return review(`${input.url.slice(0, ADDRESS_MAX / 2 - 1)}…${input.url.slice(-(ADDRESS_MAX / 2))}`);
    }
    if (name === "write_file") {
      if (typeof input.path !== "string" || !input.path.trim()) return null;
      const file = input.path.trim().split("/").at(-1);
      if (!file) return null;
      return actionReview({ locale: language, sentence: sentence.write_file }, { file: { kind: "object", title: file.slice(0, 200) } });
    }
  } catch {
    // Historical calls can predate the current bounds or carry partial input; they keep their generic tool title.
  }
  return null;
};
