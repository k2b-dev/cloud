import { type PickedPrincipal, PrincipalPicker } from "@k2b/cloud/access/v2";
import { Field } from "@k2b/ui/v2";
import { createSignal } from "solid-js";

// The people of a new chat, picked from the directory on a v2 page (see identity/authorization.md).
export function NewChatPeople() {
  const [people, setPeople] = createSignal<PickedPrincipal[]>([]);
  return (
    <Field label="People">
      <PrincipalPicker label="People" value={people()} onChange={setPeople} allowAuthenticated={false} />
    </Field>
  );
}
