import { Check, Input, Select } from "@k2b/ui/v2";
import { type JSX, Match, Switch } from "solid-js";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { FieldInput } from "../settings/_components/setting-inputs";

export type SettingControlProps = {
  entry: SettingFieldDef;
  value: unknown;
  /** Saving, a staged reset, or an unreadable value not yet confirmed: the control takes no input. */
  locked: boolean;
  /** The placeholder of a secret: an empty field keeps the stored one. */
  secretPlaceholder: string;
  error?: string;
  onChange: (value: unknown) => void;
};

const text = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const list = (value: unknown) => (Array.isArray(value) ? value.join(", ") : "");
const parts = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * The v2 control of one registry setting, chosen by its kind. Secrets start empty and are sent only when typed (the
 * server redacts them); a list is written comma-separated.
 */
export default function SettingControl(props: SettingControlProps): JSX.Element {
  const kind = () => props.entry.kind;
  return (
    <Switch
      fallback={
        <Input
          type={kind() === "email" ? "email" : kind() === "url" ? "url" : kind() === "secret" ? "password" : "text"}
          value={text(props.value)}
          placeholder={kind() === "secret" ? props.secretPlaceholder : props.entry.placeholder}
          disabled={props.locked}
          onInput={(value) => props.onChange(value)}
        />
      }
    >
      <Match when={kind() === "boolean"}>
        <Check switch label={props.entry.label} checked={props.value === true} disabled={props.locked} onChange={props.onChange} />
      </Match>
      <Match when={kind() === "number"}>
        <Input
          type="number"
          value={text(props.value)}
          min={props.entry.min}
          max={props.entry.max}
          disabled={props.locked}
          onInput={(value) => props.onChange(value === "" ? null : Number(value))}
        />
      </Match>
      <Match when={kind() === "enum"}>
        {/* k2b-ui gap: Select takes no `disabled`; a locked choice ignores changes instead. */}
        <Select
          options={props.entry.options ?? []}
          value={text(props.value) || props.entry.options?.[0]?.value}
          onChange={(value) => {
            if (!props.locked) props.onChange(value);
          }}
        />
      </Match>
      <Match when={kind() === "text"}>
        <Input multiline value={text(props.value)} placeholder={props.entry.placeholder} disabled={props.locked} onInput={props.onChange} />
      </Match>
      <Match when={kind() === "string_list"}>
        {/* k2b-ui gap: no tags input; the values are written comma-separated. */}
        <Input
          value={list(props.value)}
          placeholder={props.entry.placeholder}
          disabled={props.locked}
          onInput={(value) => props.onChange(parts(value))}
        />
      </Match>
      <Match when={kind() === "number_list"}>
        <Input
          value={list(props.value)}
          placeholder={props.entry.placeholder}
          disabled={props.locked}
          onInput={(value) =>
            props.onChange(
              parts(value)
                .map(Number)
                .filter((n) => Number.isInteger(n) && n > 0),
            )
          }
        />
      </Match>
      <Match when={kind() === "image" || kind() === "template"}>
        {/* k2b-ui gap: no image picker and no template editor in v2; the v1 controls stand in until they exist. */}
        <FieldInput entry={props.entry} value={() => props.value} error={() => props.error} onChange={props.onChange} />
      </Match>
    </Switch>
  );
}
