import { createSignal, getOwner, onCleanup, onMount, type Accessor } from "solid-js";

const MODIFIER_PRIORITY = new Map<string, number>([
  ["mod", 0],
  ["meta", 0],
  ["ctrl", 0],
  ["alt", 1],
  ["shift", 2],
]);

const isBrowser = typeof window !== "undefined" && typeof navigator !== "undefined";
const isMacPlatform = isBrowser && (
  (navigator as any).userAgentData?.platform?.toLowerCase().includes("mac") ||
  navigator.userAgent?.toLowerCase().includes("mac") ||
  false
);

export type PrettyKeyPart = {
  key: string;
  ariaLabel: string;
};

export type HotkeyDefinition = {
  label: string;
  run: () => void | Promise<void>;
  desc?: string;
  inInput?: true;
};

export type HotkeyMap = Record<string, HotkeyDefinition>;

export type RegisteredHotkeyMeta = {
  keys: string;
  keysPretty: PrettyKeyPart[];
  label: string;
  desc?: string;
};

type HotkeyConfig = HotkeyMap | (() => HotkeyMap | Promise<HotkeyMap>);

type RegisteredHotkey = RegisteredHotkeyMeta & {
  id: string;
  runtimeKey: string;
  run: () => void | Promise<void>;
  inInput: boolean;
};

// WARNING: The following variables are module-level singletons -- they are shared across
// all consumers within the same JS bundle. This means hotkey registrations from any
// component contribute to a single global registry. Take care with naming collisions
// and ensure cleanup runs when components unmount.

const [entrySignal, setEntrySignal] = createSignal<RegisteredHotkeyMeta[]>([]);
const byId = new Map<string, RegisteredHotkey>();
const byRuntimeKey = new Map<string, string>();
let sequence = 0;
let listenerAttached = false;

/**
 * Extracts and sorts modifier keys from a list of key parts according to a
 * canonical priority order (mod/meta/ctrl, alt, shift).
 */
const getModifiers = (parts: string[]) =>
  parts.filter((part) => MODIFIER_PRIORITY.has(part)).sort((a, b) => {
    return (MODIFIER_PRIORITY.get(a) ?? 99) - (MODIFIER_PRIORITY.get(b) ?? 99);
  });

/**
 * Normalizes a key combo string to a canonical form by lowercasing, sorting
 * modifiers, and validating that exactly one non-modifier key is present.
 *
 * @returns The normalized combo string, or `null` if the combo is invalid.
 *
 * @example
 * normalizeCombo("Shift+Alt+K") // "alt+shift+k"
 * normalizeCombo("K+K")         // null (two non-modifier keys)
 */
const normalizeCombo = (keys: string) => {
  const rawParts = keys
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  const modifiers = getModifiers(rawParts);
  const primaryParts = rawParts.filter((part) => !MODIFIER_PRIORITY.has(part));
  if (primaryParts.length !== 1) return null;
  return [...modifiers, primaryParts[0]].join("+");
};

/**
 * Converts a logical key combo to a platform-specific runtime key by resolving
 * the "mod" alias to "meta" (Mac) or "ctrl" (other platforms).
 */
const toRuntimeKey = (logicalKey: string) =>
  logicalKey
    .split("+")
    .map((part) => {
      if (part !== "mod") return part;
      return isMacPlatform ? "meta" : "ctrl";
    })
    .join("+");

/**
 * Converts a single key part to a human-readable display format.
 * On Mac, modifier keys are rendered as symbols (e.g. Command, Shift, Option).
 */
const toPrettyPart = (part: string): PrettyKeyPart => {
  if (part === "mod") {
    return isMacPlatform ? { key: "\u2318", ariaLabel: "Command" } : { key: "Ctrl", ariaLabel: "Control" };
  }
  if (part === "shift") {
    return isMacPlatform ? { key: "\u21E7", ariaLabel: "Shift" } : { key: "Shift", ariaLabel: "Shift" };
  }
  if (part === "alt") {
    return isMacPlatform ? { key: "\u2325", ariaLabel: "Option" } : { key: "Alt", ariaLabel: "Alt" };
  }
  if (part === "meta") {
    return { key: "\u2318", ariaLabel: "Command" };
  }
  if (part === "ctrl") {
    return { key: "Ctrl", ariaLabel: "Control" };
  }

  const key = part.length === 1 ? part.toUpperCase() : part;
  const ariaLabel = key.length === 1 ? key : key[0]?.toUpperCase() + key.slice(1);
  return { key, ariaLabel };
};

/**
 * Converts a full logical key combo string into an array of display-friendly parts.
 */
const toPrettyParts = (logicalKey: string): PrettyKeyPart[] =>
  logicalKey.split("+").map((part) => toPrettyPart(part));

/**
 * Maps a `KeyboardEvent.key` value to a normalized internal key name
 * (e.g. "Control" becomes "ctrl", " " becomes "space").
 *
 * @returns The normalized key string, or `null` if the key is empty.
 */
const toKeyboardKey = (event: KeyboardEvent): string | null => {
  const raw = event.key;
  if (!raw) return null;

  const lower = raw.toLowerCase();
  if (lower === "control") return "ctrl";
  if (lower === "meta") return "meta";
  if (lower === "alt") return "alt";
  if (lower === "shift") return "shift";
  if (lower === " ") return "space";
  if (lower === "escape") return "esc";

  return lower;
};

/**
 * Converts a `KeyboardEvent` into a runtime key string by combining active
 * modifier keys with the primary key. Returns `null` if only a modifier
 * was pressed (no primary key).
 */
const eventToRuntimeKey = (event: KeyboardEvent): string | null => {
  const mainKey = toKeyboardKey(event);
  if (!mainKey || MODIFIER_PRIORITY.has(mainKey)) return null;

  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("meta");
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");

  return [...getModifiers(modifiers), mainKey].join("+");
};

/**
 * Checks whether the event target is a text input element (input, textarea,
 * or contenteditable). Used to decide whether a hotkey should fire inside
 * text fields.
 */
const isTextTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest("[contenteditable='true']") !== null;
};

const updateEntrySignal = () => {
  setEntrySignal(
    Array.from(byId.values()).map(({ keys, keysPretty, label, desc }) => ({
      keys,
      keysPretty,
      label,
      desc,
    })),
  );
};

const onKeyDown = (event: KeyboardEvent) => {
  if (event.repeat) return;

  const runtimeKey = eventToRuntimeKey(event);
  if (!runtimeKey) return;

  const hotkeyId = byRuntimeKey.get(runtimeKey);
  if (!hotkeyId) return;

  const hotkey = byId.get(hotkeyId);
  if (!hotkey) return;

  const inText = isTextTarget(event.target);
  const hasSystemModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (inText && !hotkey.inInput && !hasSystemModifier) return;

  event.preventDefault();
  try {
    const result = hotkey.run();
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).catch((error) => {
        console.error("[hotkeys] handler failed", error);
      });
    }
  } catch (error) {
    console.error("[hotkeys] handler failed", error);
  }
};

const ensureListener = () => {
  if (!isBrowser || listenerAttached || byId.size === 0) return;
  window.addEventListener("keydown", onKeyDown);
  listenerAttached = true;
};

const maybeRemoveListener = () => {
  if (!listenerAttached || byId.size > 0) return;
  window.removeEventListener("keydown", onKeyDown);
  listenerAttached = false;
};

/**
 * Registers a single hotkey in the global registry. Returns an unregister function.
 *
 * Duplicate combos (same runtime key already registered) are silently ignored
 * with a console warning, and the returned unregister function is a no-op.
 */
const registerHotkey = (keys: string, definition: HotkeyDefinition): (() => void) => {
  const logicalKey = normalizeCombo(keys);
  if (!logicalKey) {
    console.warn(`[hotkeys] invalid combo "${keys}". Expected exactly one non-modifier key.`);
    return () => {};
  }

  const runtimeKey = toRuntimeKey(logicalKey);
  const duplicate = byRuntimeKey.get(runtimeKey);
  if (duplicate) {
    const existing = byId.get(duplicate);
    console.warn(
      `[hotkeys] duplicate combo "${logicalKey}" ignored (already registered by "${existing?.label ?? duplicate}").`,
    );
    return () => {};
  }

  const id = `hotkey-${++sequence}`;
  const entry: RegisteredHotkey = {
    id,
    keys: logicalKey,
    keysPretty: toPrettyParts(logicalKey),
    label: definition.label,
    desc: definition.desc,
    runtimeKey,
    run: definition.run,
    inInput: definition.inInput === true,
  };

  byId.set(id, entry);
  byRuntimeKey.set(runtimeKey, id);
  updateEntrySignal();
  ensureListener();

  return () => {
    byId.delete(id);
    byRuntimeKey.delete(runtimeKey);
    updateEntrySignal();
    maybeRemoveListener();
  };
};

const resolveConfig = async (config?: HotkeyConfig): Promise<HotkeyMap> => {
  if (!config) return {};
  if (typeof config === "function") return Promise.resolve(config());
  return config;
};

/**
 * Creates and registers a set of hotkeys from a static map or async factory.
 *
 * Side effects:
 * - Attaches a global `window.keydown` listener (lazily, on first registration).
 *   The listener is removed when the last hotkey is unregistered.
 * - When called inside a SolidJS reactive owner, registers `onMount` / `onCleanup`
 *   handlers so hotkeys are added after mount and removed on unmount.
 * - Can also be called outside a reactive owner (e.g. in tests); in that case
 *   hotkeys are registered immediately and must be disposed manually.
 *
 * @param config - A hotkey map, an async factory returning one, or undefined.
 * @returns `entries` -- a reactive signal of all registered hotkey metadata,
 *   and `dispose` -- a function to unregister all hotkeys from this call.
 *
 * @example
 * ```tsx
 * const { entries, dispose } = hotkeys.create({
 *   "mod+s": { label: "Save", run: () => save() },
 *   "mod+shift+z": { label: "Redo", run: () => redo() },
 * });
 * ```
 */
const createHotkeys = (
  config?: HotkeyConfig,
): {
  entries: Accessor<RegisteredHotkeyMeta[]>;
  dispose: () => void;
} => {
  let disposed = false;
  const unregisterFns: Array<() => void> = [];

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    while (unregisterFns.length > 0) {
      const unregister = unregisterFns.pop();
      unregister?.();
    }
  };

  const registerAll = async () => {
    const map = await resolveConfig(config);
    if (disposed) return;

    for (const [keys, definition] of Object.entries(map)) {
      if (disposed) break;
      unregisterFns.push(registerHotkey(keys, definition));
    }
  };

  const owner = getOwner();
  if (owner) {
    onMount(() => {
      if (!isBrowser) return;
      void registerAll();
    });
    onCleanup(dispose);
  } else if (isBrowser) {
    void registerAll();
  }

  return {
    entries: entrySignal,
    dispose,
  };
};

/**
 * Reactive signal containing metadata for all currently registered hotkeys.
 * Useful for rendering a help overlay or command palette.
 */
const hotkeyEntries = entrySignal;

export const hotkeys = {
  create: createHotkeys,
  entries: hotkeyEntries,
} as const;
