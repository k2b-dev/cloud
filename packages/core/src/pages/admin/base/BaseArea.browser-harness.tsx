import { LocaleProvider } from "@k2b/ui";
import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { LinuxScreen, type LinuxScreenProps, SigninFormScreen, type SigninFormScreenProps } from "../signin/SigninScreen";
import BaseScreen, { type BaseScreenProps } from "./BaseScreen";

// A Base or Sign-in section on v2: the screen mounts fresh in the page's main area with the props the server rendered.
const data = document.getElementById("screen-props");
const main = document.querySelector<HTMLElement>("main.k2-ui");
if (data && main) {
  const text = data.textContent ?? "{}";
  const screen = (): JSX.Element => {
    if (data.dataset.screen === "linux") {
      const props: LinuxScreenProps = JSON.parse(text);
      return createComponent(LinuxScreen, props);
    }
    if (data.dataset.screen === "signin") {
      const props: SigninFormScreenProps = JSON.parse(text);
      return createComponent(SigninFormScreen, props);
    }
    const props: BaseScreenProps = JSON.parse(text);
    return createComponent(BaseScreen, props);
  };
  main.replaceChildren();
  render(
    () =>
      createComponent(LocaleProvider, {
        locale: document.documentElement.lang,
        get children() {
          return screen();
        },
      }),
    main,
  );
}
document.body.dataset.ready = "true";
