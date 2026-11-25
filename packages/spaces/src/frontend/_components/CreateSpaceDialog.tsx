import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Button, Dialog, Field, Input, Notice, Select } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { setLastSpaceId, writeSpaceSettings } from "../[id]/_components/settings/SpaceSettingsStore";
import { createSpaceRequest, type SpaceStarter, spaceStarters, starterView } from "../create-space-dialog";
import { overviewMessages } from "../overview-messages";
import { spaceColorOptions } from "./space-colors";

/**
 * "New space" on v2: a starter, the name, a description and the colour. It stays open until the server answers; a
 * refusal shows in the dialog with the input kept. The new Space opens with the starter's view.
 */
export default function CreateSpaceDialog(props: { open: boolean; onClose: () => void }) {
  const locale = useLocale();
  const t = () => overviewMessages.resolve([locale()]).t;
  const starters = () => spaceStarters(t());
  const [starter, setStarter] = createSignal<SpaceStarter>(spaceStarters(t())[0]!);
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [color, setColor] = createSignal(starter().color);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [missing, setMissing] = createSignal(false);
  const chooseStarter = (id: string) => {
    const selected = starters().find((entry) => entry.id === id);
    if (!selected) return;
    // A starter fills only what still shows the previous starter's text, so typed input stays.
    const previous = starter();
    const filled = (value: string, text: string) => value === "" || value === (previous.id === "blank" ? "" : text);
    if (filled(name(), previous.name)) setName(selected.id === "blank" ? "" : selected.name);
    if (filled(description(), previous.description)) setDescription(selected.id === "blank" ? "" : selected.description);
    if (color() === previous.color) setColor(selected.color);
    setStarter(selected);
  };
  const close = () => {
    if (!busy()) props.onClose();
  };
  const submit = async () => {
    if (busy()) return;
    if (!name().trim()) return setMissing(true);
    setBusy(true);
    setError(null);
    try {
      const chosen = starter();
      const space = await createSpaceRequest(
        { name: name().trim(), description: description().trim(), color: color(), starter: chosen },
        t().createFailed,
      );
      setLastSpaceId(space.id);
      writeSpaceSettings(space.id, { view: starterView[chosen.id] });
      // Opening the new Space is the confirmation.
      navigateTo(`/app/spaces/${space.id}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t().createFailed);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t().newSpace}
      open={props.open}
      onOpenChange={(open) => !open && close()}
      foot={
        <>
          <Button onClick={close} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} onClick={() => void submit()}>
            {t().create}
          </Button>
        </>
      }
    >
      <Field label={t().template} name="starter" hint={starter().description}>
        <Select
          value={starter().id}
          options={starters().map((entry) => ({ value: entry.id, label: entry.name }))}
          onChange={chooseStarter}
        />
      </Field>
      <Notice tone="note" icon="shield-check">
        {t().adminNotice}
      </Notice>
      <Field label={t().name} name="name" hint={t().nameDescription} error={missing() ? t().nameRequired : undefined} required>
        <Input
          value={name()}
          placeholder={starter().name}
          disabled={busy()}
          onInput={(value) => {
            setName(value);
            setMissing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void submit();
          }}
        />
      </Field>
      <Field label={t().description} name="description" hint={t().descriptionDescription} optional={t().optional}>
        <Input multiline value={description()} placeholder={starter().description} disabled={busy()} onInput={setDescription} />
      </Field>
      <Field label={t().color} name="color" hint={t().colorDescription}>
        {/* k2b-ui gap: v2 has no colour input; the Space picks from the named palette (its own colour stays an option). */}
        <Select value={color()} options={spaceColorOptions(locale(), color())} onChange={setColor} />
      </Field>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}
