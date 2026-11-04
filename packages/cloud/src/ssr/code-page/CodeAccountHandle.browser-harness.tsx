import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { CodeAccountHandle } from "./CodeAccountHandle";

render(
  () => (
    <LocaleProvider locale="de">
      <CodeAccountHandle handle="code-7k2q9m4xwt" />
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
