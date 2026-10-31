import { Button, dialogCore, PanelDialog, panelDialogOptions, TextInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { appsHref } from "./model";
import { appsPageMessages } from "./page-messages";

const APP_ID = /^[a-z][a-z0-9-]{0,79}$/;
const RESERVED = new Set(["core", "gateway"]);

/**
 * "Add app" for an app that never ran, such as a third-party app: it asks for the app ID and opens the app's keys,
 * where the first key makes Core know the app. A known ID opens that app instead.
 */
export default function AddApp(props: { known: ReadonlyArray<{ id: string; name: string }> }) {
  const locale = useLocale();
  const t = () => appsPageMessages.resolve([locale()]).t;
  const open = () =>
    void dialogCore.open<void>(
      (close) => {
        const [id, setId] = createSignal("");
        const value = () => id().trim();
        const known = () => props.known.find((app) => app.id === value());
        const error = () => (!value() ? null : !APP_ID.test(value()) ? t().appIdFormat : RESERVED.has(value()) ? t().appIdReserved : null);
        const submit = (event: SubmitEvent) => {
          event.preventDefault();
          if (!value() || error()) return;
          close();
          window.location.assign(appsHref({ app: value(), view: known() ? null : "keys" }));
        };
        return (
          <form class="contents" onSubmit={submit} data-add-app>
            <PanelDialog>
              <PanelDialog.Header title={t().addTitle} icon="ti ti-plus" close={() => close()} />
              <PanelDialog.Body>
                <div class="flex flex-col gap-3">
                  <p>{t().addText}</p>
                  <TextInput
                    label={t().appId}
                    value={id}
                    onValueChange={setId}
                    monospace
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck={false}
                    required
                    error={() => error() ?? undefined}
                    description={known() ? t().appIdKnown({ name: known()!.name }) : t().appIdHelp}
                  />
                </div>
              </PanelDialog.Body>
              <PanelDialog.Footer>
                <Button variant="secondary" onClick={() => close()}>
                  {t().cancel}
                </Button>
                <Button type="submit" disabled={!value() || Boolean(error())}>
                  {t().continue}
                </Button>
              </PanelDialog.Footer>
            </PanelDialog>
          </form>
        );
      },
      { ...panelDialogOptions, ariaLabel: t().addTitle, initialFocus: "first-input" },
    );
  return (
    <Button size="sm" variant="secondary" onClick={open}>
      <i class="ti ti-plus" aria-hidden="true" />
      {t().addApp}
    </Button>
  );
}
