import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import NoNotebooks from "./NoNotebooks";

/** The workspace without any notebook, for the browser test, with two invented templates. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");

render(
  () => (
    <LocaleProvider locale="de">
      <NoNotebooks
        templates={[
          { id: "daily", name: "Tagebuch", description: "Eine Notiz pro Tag mit Rückblick.", icon: "ti ti-calendar" },
          { id: "recipe", name: "Rezepte", description: "Zutaten, Schritte und Bilder.", icon: "ti ti-chef-hat" },
        ]}
      />
    </LocaleProvider>
  ),
  host,
);
