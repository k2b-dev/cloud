import type { RenderFn } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import type { AppInstallable } from "../contracts/installable";
import AppPwaRuntime from "./AppPwaRuntime.island";

/** Called by the framework, even when the application renders its own layout. */
export const appPwaDocument =
  (render: RenderFn, app: AppInstallable, locale: string): RenderFn =>
  () => (
    <>
      {render()}
      <LocaleProvider locale={locale}>
        <AppPwaRuntime app={app} />
      </LocaleProvider>
    </>
  );
