import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { CodeAccountHandle } from "./CodeAccountHandle";
import { codePageMessages } from "./messages";

// The account line as the Code page's head shows it, so its wrap is measured in place.
render(
  () => (
    <LocaleProvider locale="de">
      <div class="cloud-code">
        <header class="cloud-code__head">
          <div class="cloud-code__head-text">
            <p class="cloud-code__lead">
              {codePageMessages.resolve(["de"]).t.runsAsAccount({ name: "Code von info@beispiel.de" })}{" "}
              <CodeAccountHandle handle="code-7k2q9m4xwt" />
            </p>
          </div>
        </header>
      </div>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
