/**
 * The Solid 1 adapter for `@ui-sdk/core` primitives. Internal to `@k2b/ui`: no app and no public v2 export sees it.
 *
 * It does what `@ui-sdk/solid` (Solid 2) does in its use-primitive, reduced to what v2 needs:
 * - `usePrimitive`: one instance per component; option changes reach the instance before the render that reads them;
 * - `part`: a slot rendered as an element, with the slot's attributes, its handlers (the author's run first and may
 *   `preventDefault`), core's element binding (focus, keys, dismissal, positioning) and the slot state for a children
 *   function; a slot whose presence depends on state renders only while present;
 * - `popupPart`: a part that comes and goes, in the top layer, or in a portal where there is none;
 * - `keyed`: the props of a keyed slot (a menu item, a select option), with the id core derives from its value.
 *
 * Everything core-side comes from `@ui-sdk/core/renderer`, the entry every official adapter builds on. Core documents
 * it as "not public API, may change with any release". The contract tests in this folder run on every update.
 *
 * Solid 1 needs no `instance.follow`: `createComputed` hands options over synchronously, and a change core marks as
 * `delivered` (one that came through the options, like a controlled `open`) is rendered like any other.
 */
import type { Part, Primitive, PrimitiveInstance, PropSpec, SlotName, TypesOf } from "@ui-sdk/core";
import {
  conditional,
  createListSnapshots,
  present as isPresent,
  attrs as partAttrs,
  handlers as partHandlers,
  partState,
  portalTarget,
  ref,
  sameSlotState,
  sameValue,
  schemaOf,
  subscribe,
  takeOwnId,
  yieldToAuthor,
} from "@ui-sdk/core/renderer";
import {
  type Accessor,
  createComputed,
  createMemo,
  createSignal,
  createUniqueId,
  getOwner,
  type JSX,
  mergeProps,
  on,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  splitProps,
  untrack,
} from "solid-js";
import { Dynamic, isServer, Portal, Properties } from "solid-js/web";

export type Props = Record<string, unknown>;

export type Handle<P extends Primitive> = {
  primitive: P;
  instance: PrimitiveInstance;
  readonly api: TypesOf<P>["api"];
};

const sameRecord = (a: Props, b: Props) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue(a[key], b[key]));
};

/** An option or attribute given as undefined is one not given: a controlled `open: undefined` would pin the state. */
const clean = (record: Props): Props => {
  const out: Props = {};
  for (const [name, value] of Object.entries(record)) if (value !== undefined) out[name] = value;
  return out;
};

/**
 * Core writes a boolean attribute the HTML way, as `""` (`hidden: ""` on a closed popup). Solid 1 sets `hidden`,
 * `disabled`, `inert` … as properties on the client and drops falsy ones on the server, so `""` would mean "off" in
 * both. They become `true` here.
 */
export const toSolidAttrs = (attrs: Props): Props => {
  const out = clean(attrs);
  for (const [name, value] of Object.entries(out)) {
    if (value === "" && Properties.has(name) && name !== "value" && name !== "className") out[name] = true;
  }
  return out;
};

/**
 * One instance for the calling component. `given` is read reactively. A change reaches the instance before the render
 * effects of the same update, because `createComputed` runs synchronously in Solid 1. Lists in the options (a select's
 * `items`) are snapshotted, so a store array changed in place still reaches the instance.
 */
export function usePrimitive<P extends Primitive>(primitive: P, given: () => Props = () => ({})): Handle<P> {
  const id = `ui-sdk-${createUniqueId()}`;
  const owner = getOwner();
  const snapshot = createListSnapshots(primitive, <V,>(compute: () => V) => runWithOwner(owner, () => createMemo(compute)) ?? compute);
  const options = () => snapshot({ ...clean(given()), id });
  let last = untrack(options);
  const instance = untrack(() => primitive(last));
  onCleanup(() => instance.destroy());
  createComputed(() => {
    const next = options();
    if (sameRecord(next, last)) return;
    last = next;
    untrack(() => instance.setOptions(next));
  });
  return {
    primitive,
    instance,
    get api() {
      return instance.api as TypesOf<P>["api"];
    },
  };
}

type Watch = { state: Accessor<void>; attrs: Accessor<void> };

/**
 * Two signals core bumps for the part while it renders: `state` on every change that can affect it, `attrs` unless only
 * attributes core writes to the element itself changed (`liveOnly`). A keyed part whose props change is another part
 * record, so the subscription moves with it.
 */
function watch(current: () => Part): Watch {
  const [state, bumpState] = createSignal<void>(undefined, { equals: false });
  const [attrs, bumpAttrs] = createSignal<void>(undefined, { equals: false });
  if (isServer) return { state, attrs };
  let stop = () => {};
  let subscribed: Part | undefined;
  createComputed(() => {
    const part = current();
    if (part === subscribed) return;
    stop();
    subscribed = part;
    stop = subscribe(
      part,
      (liveOnly) => {
        bumpState();
        if (!liveOnly) bumpAttrs();
      },
      part.props,
    );
  });
  onCleanup(() => stop());
  return { state, attrs };
}

/** The slot state a children function reads: one memo per key, so a reader only runs again when its key changes. */
function slotState(watched: Watch, current: () => Part): Props {
  const all = createMemo(
    () => {
      watched.state();
      const now = current();
      return partState(now, now.props) as Props;
    },
    undefined,
    { equals: sameSlotState },
  );
  const owner = getOwner();
  const keys = new Map<string, Accessor<unknown>>();
  return new Proxy({} as Props, {
    get(_, key) {
      if (typeof key !== "string") return undefined;
      let memo = keys.get(key);
      if (!memo) {
        memo = runWithOwner(owner, () => createMemo(() => all()[key], undefined, { equals: sameSlotState }));
        if (!memo) return all()[key];
        keys.set(key, memo);
      }
      return memo();
    },
  });
}

const callUser = (handler: unknown, event: Event) => {
  if (typeof handler === "function") handler(event);
  else if (Array.isArray(handler) && typeof handler[0] === "function") handler[0](handler[1], event);
};

const host = { by: "framework", attaches: "all" } as const;

/** Element props for a part: attributes, `class`, author handlers (`onKeyDown` …), `ref`, and children. */
export type PartProps = Props & {
  children?: JSX.Element | ((state: Props) => JSX.Element);
  ref?: (el: HTMLElement) => void;
};

/**
 * Renders one slot as `tag`. `partProps` are the slot's own props (an item's `value`, a content's `side`); `user` are
 * element props. A children function with a parameter gets the slot state. A slot whose presence depends on state
 * (a popup's content, a select's clear button) renders only while core says it is present.
 */
export function part<P extends Primitive>(
  handle: Handle<P>,
  slot: SlotName<P>,
  partProps: () => Props = () => ({}),
  user: PartProps = {},
  tag = "div",
): JSX.Element {
  const current = () => handle.instance.part(slot, partProps());
  const record = untrack(current);
  const watched = watch(current);
  const state = slotState(watched, current);

  // Handlers go on the element as native listeners (`on:type`), so core sees the same event order as on a plain
  // element. The author's handler for the same type runs first; `preventDefault` there skips core's.
  const handlers: Props = {};
  const taken = new Set<string>(["children", "ref"]);
  for (const type of Object.keys(partHandlers(record))) {
    const authorKey = Object.keys(user).find((key) => key.toLowerCase() === `on${type}`);
    if (authorKey) taken.add(authorKey);
    handlers[`on:${type}`] = (event: Event) => {
      if (authorKey) callUser(user[authorKey], event);
      if (!event.defaultPrevented) partHandlers(current())[type as keyof HTMLElementEventMap]?.(event);
    };
  }

  const attrs = createMemo(
    () => {
      watched.attrs();
      const now = current();
      takeOwnId(now, user.id);
      return toSolidAttrs(yieldToAuthor(partAttrs(now, now.props), (name) => user[name] != null));
    },
    undefined,
    { equals: sameRecord },
  );

  const [, rest] = splitProps(user, [...taken]);

  // One element's life. Core binds it once it is in the page and unbinds it when it leaves; this runs inside the
  // `Show` of a part that comes and goes, so a panel shown later binds then. A keyed part whose key changes hands the
  // element over. The children are created here too, not before: an inactive panel's content does not exist (on the
  // server either), and whatever it creates is disposed when the part goes.
  const render = () => {
    // A children function gets the slot state and runs again only when a state key it reads changes (one memo per
    // key). Components it creates (a `For` over `state.items`) track their own reads, so they are not recreated.
    // Other children are read where they are inserted, as Solid reads `props.children`: a text such as a dialog's
    // title follows its prop.
    const content = () => {
      const given = user.children;
      return typeof given === "function" && given.length > 0 ? given(state) : given;
    };
    let element: HTMLElement | undefined;
    let bound = ref(record, host);
    if (!isServer) {
      onMount(() => element && bound(element));
      createComputed(
        on(
          current,
          (next) => {
            const nextBound = ref(next, host);
            if (nextBound === bound) return;
            if (element) bound(null);
            bound = nextBound;
            if (element) bound(element);
          },
          { defer: true },
        ),
      );
      onCleanup(() => element && bound(null));
    }
    const merged = mergeProps(rest, attrs, handlers, {
      ref: (el: HTMLElement) => {
        element = el;
        user.ref?.(el);
      },
      children: content,
    });
    return <Dynamic component={tag} {...merged} />;
  };
  if (!conditional(record)) return render();
  const shown = () => {
    watched.state();
    const now = current();
    return isPresent(now, now.props);
  };
  return <Show when={shown()}>{render()}</Show>;
}

/** Whether the slot's element should exist now. */
export function present<P extends Primitive>(handle: Handle<P>, slot: SlotName<P>, partProps: () => Props = () => ({})): Accessor<boolean> {
  const current = () => handle.instance.part(slot, partProps());
  const watched = watch(current);
  return () => {
    watched.state();
    const now = current();
    return isPresent(now, now.props);
  };
}

/** A part that comes and goes (a popup's content or backdrop): in the top layer where supported, else in a portal. */
export function popupPart<P extends Primitive>(
  handle: Handle<P>,
  slot: SlotName<P>,
  partProps: () => Props = () => ({}),
  user: PartProps = {},
  wrap?: (element: () => JSX.Element) => JSX.Element,
): JSX.Element {
  const shown = present(handle, slot, partProps);
  const element = () => part(handle, slot, partProps, user, "div");
  const content = () => (wrap ? wrap(element) : element());
  return (
    <Show when={shown()}>
      <Show when={isServer ? null : portalTarget(undefined)} fallback={content()}>
        {(mount) => <Portal mount={mount()}>{content()}</Portal>}
      </Show>
    </Show>
  );
}

/** Wraps a popup's content in its `viewport` slot while the presentation needs one (a sheet on phones). */
export const viewport =
  <P extends Primitive>(handle: Handle<P>, user: PartProps = {}) =>
  (element: () => JSX.Element): JSX.Element => {
    const shown = present(handle, "viewport" as SlotName<P>);
    return (
      <Show when={shown()} fallback={element()}>
        {part(handle, "viewport" as SlotName<P>, undefined, { ...user, children: element() })}
      </Show>
    );
  };

/** `api.internal.keyOf` of core's list primitives, which find an item by the id it derives from the value. */
const keyOf = (api: unknown, value: string): string => {
  if (typeof api !== "object" || api === null || !("internal" in api)) return value;
  const internal = api.internal;
  if (typeof internal !== "object" || internal === null || !("keyOf" in internal) || typeof internal.keyOf !== "function") return value;
  const key: unknown = internal.keyOf(value);
  return typeof key === "string" ? key : value;
};

/** The props of a keyed slot; a primitive of ours without `keyOf` uses the value itself as the id. */
export function keyed<P extends Primitive>(handle: Handle<P>, value: string, more: Props = {}): Props {
  return { ...more, value, id: keyOf(handle.api, value) };
}

/** Ids for `id`-kind slot props (triggers), stable across server and client render order. */
export const partId = (): string => createUniqueId();

export type SlotComponent = (props: PartProps) => JSX.Element;

const kindOf = (spec: PropSpec | undefined) => (typeof spec === "string" ? spec : typeof spec === "object" ? spec.kind : "value");

/**
 * A component for one slot of one instance. Its props split by the slot's schema: the slot's own props (`value`,
 * `label`, `side` …) go to core, the rest to the element. An `id`-kind prop the author leaves out gets a made id; a
 * keyed slot gets the id core derives from its value. `fixed` adds slot props the component always passes.
 */
export function slotComponent<P extends Primitive>(
  handle: Handle<P>,
  slot: SlotName<P>,
  tag: string,
  fixed: () => Props = () => ({}),
): SlotComponent {
  const spec = schemaOf(handle.primitive).slots[slot] ?? {};
  const names = Object.keys(spec);
  const made = names.filter((name) => kindOf(spec[name]) === "id");
  const key = names.find((name) => kindOf(spec[name]) === "key");
  const own = names.filter((name) => name !== "id");
  return (props) => {
    const ids: Props = {};
    for (const name of made) ids[name] = partId();
    const [, element] = splitProps(props, own);
    const partProps = () => {
      const named: Props = { ...ids, ...fixed() };
      for (const name of names) if (props[name] !== undefined) named[name] = props[name];
      const value = key === undefined ? undefined : named[key];
      return typeof value === "string" ? keyed(handle, value, named) : named;
    };
    return part(handle, slot, partProps, element, tag);
  };
}

/** A popup slot (content) as a component: present only while open, in the top layer or a portal, in its viewport. */
export function popupComponent<P extends Primitive>(handle: Handle<P>, slot: SlotName<P>, fixed: () => Props = () => ({})): SlotComponent {
  const spec = schemaOf(handle.primitive).slots[slot] ?? {};
  const own = Object.keys(spec).filter((name) => name !== "id");
  return (props) => {
    const [, element] = splitProps(props, own);
    const partProps = () => {
      const named: Props = { ...fixed() };
      for (const name of own) if (props[name] !== undefined) named[name] = props[name];
      return named;
    };
    // A tooltip has no viewport slot: it never turns into a sheet.
    return popupPart(handle, slot, partProps, element, "viewport" in schemaOf(handle.primitive).slots ? viewport(handle) : undefined);
  };
}
