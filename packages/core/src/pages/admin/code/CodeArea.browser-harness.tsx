import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import CodeScreen, { type CodeScreenProps } from "./screen";

// A Code section on v2: its screen mounts fresh in the page's main area with the props the server rendered.
const data = document.getElementById("screen-props");
const main = document.querySelector<HTMLElement>("main.k2-ui");
if (data && main) {
  const props: CodeScreenProps = JSON.parse(data.textContent ?? "{}");
  main.replaceChildren();
  render(
    () =>
      createComponent(LocaleProvider, {
        locale: document.documentElement.lang,
        get children() {
          return createComponent(CodeScreen, props);
        },
      }),
    main,
  );
  main.dataset.ready = "true";
}
document.body.dataset.ready = "true";
