/**
 * Binds one slot of an instance to an element someone else rendered (a row, a button), so the behaviour needs no
 * wrapper element of its own: a wrapper would break the child combinators of the v2 layout (`.k2-list > .k2-row`).
 * Core attaches its listeners itself (`by: "core"`); the slot's attributes are written onto the element and kept
 * current. An attribute the element already has stays the author's.
 *
 * k2b-ui gap: this belongs in the adapter beside `part` ("a slot on an element the author renders"); it lives here
 * until the adapter has it.
 */
import type { Primitive, SlotName } from "@ui-sdk/core";
import { attrs as partAttrs, ref, subscribe } from "@ui-sdk/core/renderer";
import type { Handle, Props } from "./adapter";

export function bindSlot<P extends Primitive>(handle: Handle<P>, slot: SlotName<P>, props: Props, element: HTMLElement): () => void {
  const part = handle.instance.part(slot, props);
  const own = new Set(element.getAttributeNames());
  const written = new Set<string>();
  const write = () => {
    const next = partAttrs(part, part.props);
    for (const name of written) {
      if (next[name] == null) {
        element.removeAttribute(name);
        written.delete(name);
      }
    }
    for (const [name, value] of Object.entries(next)) {
      if (own.has(name) || value == null) continue;
      element.setAttribute(name, String(value));
      written.add(name);
    }
  };
  write();
  const stop = subscribe(part, write, part.props);
  const bind = ref(part, { by: "core" });
  bind(element);
  return () => {
    stop();
    bind(null);
    for (const name of written) element.removeAttribute(name);
  };
}
