import { Button, Check, Dialog, Field, Input, Notice, Select, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { type CreateGroupResult, normalizeName, useCreateGroupForm } from "./new-group";

/** Longest group name and description the server takes. */
const NAME_MAX = 120;
const DESCRIPTION_MAX = 4000;

/**
 * The dialog for a new group on v2: who manages it (with FreeIPA), its name in the normalized form, a description, and
 * whether it is a POSIX group. The same form as the v1 dialog (`useCreateGroupForm`): the same rules, the same request,
 * and an edited form asks before it closes.
 */
export default function NewGroupDialog(props: {
  open: boolean;
  freeIpaEnabled: boolean;
  linuxEnabled: boolean;
  close: (result?: CreateGroupResult) => void;
}) {
  const form = useCreateGroupForm(props);
  const t = form.messages;
  const busy = () => form.createMutation.loading();
  const localWithoutLinux = () => form.provider() === "local" && !props.linuxEnabled;
  // k2b-ui gap: v2 Input has no maxLength; the form holds the server's limits itself.
  const tooLong = () => form.name().length > NAME_MAX || form.description().length > DESCRIPTION_MAX;
  const create = () => {
    if (tooLong()) return form.setError(t().groupNameInvalid);
    form.submit();
  };
  return (
    <Dialog
      title={t().createGroup}
      open={props.open}
      onOpenChange={(open) => {
        if (!open) void form.requestClose();
      }}
      foot={
        <>
          <Button onClick={() => void form.requestClose()} disabled={busy() || form.closing()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} onClick={create}>
            {t().createGroup}
          </Button>
        </>
      }
    >
      <Show when={props.freeIpaEnabled}>
        <Field
          name="provider"
          label={t().managedBy}
          hint={form.provider() === "ipa" ? t().freeIpaGroupDescription : t().localGroupDescription}
        >
          <Select
            value={form.provider()}
            options={[
              { value: "ipa", label: "FreeIPA" },
              { value: "local", label: t().local },
            ]}
            onChange={(value) => {
              if (value === "ipa" || value === "local") {
                form.setProvider(value);
                form.setDirty(true);
              }
            }}
          />
        </Field>
      </Show>
      <Field name="name" label={t().name} hint={t().normalizedGroupName} error={form.error()} required>
        <Input
          value={form.name()}
          placeholder="my-group"
          disabled={busy()}
          onInput={(value) => {
            form.setName(value);
            form.setError(undefined);
            form.setDirty(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) create();
          }}
        />
      </Field>
      <Show when={form.name() && form.name() !== normalizeName(form.name())}>
        <Text type="meta">{`${t().name}: ${normalizeName(form.name()) || "—"}`}</Text>
      </Show>
      <Field name="description" label={t().description}>
        <Input
          multiline
          value={form.description()}
          disabled={busy()}
          onInput={(value) => {
            form.setDescription(value);
            form.setDirty(true);
          }}
        />
      </Field>
      <Check
        name="posix"
        label={t().createPosixGroup}
        checked={form.posix()}
        disabled={busy() || localWithoutLinux()}
        onChange={form.choosePosix}
      />
      <Text type="meta">{localWithoutLinux() ? t().localPosixUnavailable : t().posixGroupDescription}</Text>
      <Show when={form.createMutation.error()}>
        {(error) => (
          <Notice tone="bad" icon="alert-circle">
            {error().message}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}
