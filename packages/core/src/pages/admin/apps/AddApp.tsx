import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Button, Dialog, Field, Input, Text } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import { type AppsListState, appsHref } from "./model";
import { appsPageMessages } from "./page-messages";

const APP_ID = /^[a-z][a-z0-9-]{0,79}$/;
const RESERVED = new Set(["core", "gateway"]);

/**
 * "Add app" for an app that never ran, such as a third-party app: it asks for the app ID and opens the app's keys,
 * where the first key makes Core know the app. A known ID opens that app instead.
 */
export default function AddApp(props: { known: ReadonlyArray<{ id: string; name: string }>; list: AppsListState }) {
  const locale = useLocale();
  const t = () => appsPageMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(false);
  const [id, setId] = createSignal("");
  const value = () => id().trim();
  const known = () => props.known.find((app) => app.id === value());
  const error = () =>
    !value() ? undefined : !APP_ID.test(value()) ? t().appIdFormat : RESERVED.has(value()) ? t().appIdReserved : undefined;
  const go = () => {
    if (!value() || error()) return;
    setOpen(false);
    void navigateTo(appsHref({ app: value(), view: known() ? null : "keys", list: props.list }));
  };
  return (
    <>
      <Button
        icon="plus"
        onClick={() => {
          setId("");
          setOpen(true);
        }}
      >
        {t().addApp}
      </Button>
      <Dialog
        title={t().addTitle}
        open={open()}
        onOpenChange={setOpen}
        foot={
          <>
            <Button onClick={() => setOpen(false)}>{t().cancel}</Button>
            <Button variant="primary" disabled={!value() || Boolean(error())} onClick={go}>
              {t().continue}
            </Button>
          </>
        }
      >
        <Text>{t().addText}</Text>
        <Field
          name="app-id"
          label={t().appId}
          hint={known() ? t().appIdKnown({ name: known()!.name }) : t().appIdHelp}
          error={error()}
          required
        >
          <Input
            value={id()}
            onInput={setId}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing) go();
            }}
          />
        </Field>
      </Dialog>
    </>
  );
}
