import { onCleanup } from "solid-js";
import { type Store, type SetStoreFunction, createStore, reconcile } from "solid-js/store";

// ==========================
// Types
// ==========================

type StoreItem<T> = T & { _key: string };

type Serializer = {
  serialize: (value: any) => string;
  deserialize: (raw: string) => any;
};

type LocalStoreQueryOptions<T extends Record<string, any>> = {
  storage?: Storage;
  enhanceRecord?: (item: StoreItem<T>) => StoreItem<T>;
};

type CreateLocalStoreOptions = {
  storage?: Storage;
  serializer?: Serializer;
};

type CreateLocalStoreResult<T extends Record<string, any>> = [
  Store<StoreItem<T>>,
  SetStoreFunction<StoreItem<T>>,
];

type CreateLocalStoreQueryResult<T extends Record<string, any>> = [
  Store<StoreItem<T>[]>,
  () => void,
];

type ListenerCallback = (key: string, value?: any) => void;
type KeyFilter = (key: string) => boolean;

// ==========================
// Default Serializer
// ==========================

const defaultSerializer: Serializer = {
  serialize: JSON.stringify,
  deserialize: JSON.parse,
};

// ==========================
// Internal Sync System
// ==========================

// Browser-only channel used for cross-tab synchronization. It is created on
// first localStore use rather than module evaluation because server runtimes
// such as Bun also expose BroadcastChannel and would otherwise retain a live
// process handle when merely importing @k2b/stdlib/solid.
let globalChannel: BroadcastChannel | null = null;
const listeners = new Map<string | Function, Set<ListenerCallback>>();

const getGlobalChannel = (): BroadcastChannel | null => {
  if (globalChannel) return globalChannel;
  if (
    typeof window === "undefined" ||
    typeof window.BroadcastChannel !== "function"
  ) {
    return null;
  }

  globalChannel = new window.BroadcastChannel("localstorage-sync");
  if (typeof globalChannel.addEventListener === "function") {
    globalChannel.addEventListener("message", (event) => {
      const { key } = (event as MessageEvent).data;
      notify(key, undefined, true);
    });
  }
  return globalChannel;
};

/**
 * Subscribes a callback to notifications for a specific key or a key-matching filter function.
 * Returns an unsubscribe function.
 */
const subscribe = (
  keyOrFilter: string | KeyFilter,
  callback: ListenerCallback,
): (() => void) => {
  getGlobalChannel();
  if (!listeners.has(keyOrFilter)) listeners.set(keyOrFilter, new Set());
  listeners.get(keyOrFilter)!.add(callback);
  return () => listeners.get(keyOrFilter)?.delete(callback);
};

/**
 * Notifies all subscribers matching the given key (exact-match and filter-function subscribers).
 * Also broadcasts the change to other tabs via BroadcastChannel, unless the notification
 * itself originated from a broadcast (to avoid infinite loops).
 */
const notify = (key: string, value?: any, __fromBroadcast = false): void => {
  listeners.get(key)?.forEach((callback) => callback(key, value));
  listeners.forEach((callbacks, keyOrFilter) => {
    if (typeof keyOrFilter === "function" && keyOrFilter(key)) {
      callbacks.forEach((callback) => callback(key, value));
    }
  });
  if (!__fromBroadcast) {
    const channel = getGlobalChannel();
    if (channel) {
      setTimeout(() => {
        try {
          channel.postMessage({ key });
        } catch {
          // Channel closed or runtime missing postMessage — ignore.
        }
      }, 0);
    }
  }
};

// ==========================
// Public API
// ==========================

/**
 * Creates a reactive store with automatic localStorage persistence and cross-tab sync.
 *
 * The store object always contains an internal `_key` field holding the localStorage key.
 * Changes made via the returned `setStore` function are automatically persisted and
 * broadcast to other tabs. Changes from other tabs are received via BroadcastChannel
 * and update the local reactive store.
 *
 * @param key - Unique localStorage key for this store
 * @param defaultValue - Default value when storage is empty or invalid
 * @param options - Optional storage and serializer configuration
 * @returns A tuple containing [store, setStore]
 *
 * @example
 * const [user, setUser] = localStore.create("user", { name: "", email: "" });
 * setUser("name", "John"); // Automatically syncs across tabs
 */
const create = <T extends Record<string, any>>(
  key: string,
  defaultValue: T,
  options: CreateLocalStoreOptions = {},
): CreateLocalStoreResult<T> => {
  const { storage = localStorage, serializer = defaultSerializer } = options;

  /** Validate that a parsed value matches the StoreItem<T> shape: a plain
   *  object whose `_key` matches the key we're rehydrating. Accepts only
   *  values that are safely usable as the reactive store; falls back to
   *  defaults for null/array/primitive/wrong-key inputs. */
  const isValidStoreItem = (v: unknown): v is StoreItem<T> => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const candidate = v as Record<string, unknown>;
    return candidate._key === key;
  };

  const getInitialValue = (): StoreItem<T> => {
    try {
      const stored = storage.getItem(key);
      if (!stored) return { ...defaultValue, _key: key };
      const parsed = serializer.deserialize(stored);
      if (!isValidStoreItem(parsed)) {
        // Corrupted or wrong-shape data — fall back to defaults rather than
        // hand the user a value that violates the StoreItem contract.
        return { ...defaultValue, _key: key };
      }
      return parsed;
    } catch {
      return { ...defaultValue, _key: key };
    }
  };

  const [store, _setStore] = createStore<StoreItem<T>>(getInitialValue());

  const unsubscribe = subscribe(key, (_, value?: any) => {
    if (value === null) {
      // Cross-tab remove or local reset: fully replace with defaults so any
      // properties present in the previous state are dropped (was: merge
      // via `_setStore(object)` which left stale fields visible).
      _setStore(reconcile({ ...defaultValue, _key: key }));
    } else if (value && isValidStoreItem(value)) {
      _setStore(reconcile(value));
    } else {
      const newValue = getInitialValue();
      _setStore(reconcile(newValue));
    }
  });
  onCleanup(unsubscribe);

  const setStore: SetStoreFunction<StoreItem<T>> = (...args: any) => {
    const result = (_setStore as any)(...args);
    try {
      storage.setItem(key, serializer.serialize(store));
    } catch (error) {
      console.warn(`Failed to store ${key}:`, error);
      return result;
    }
    notify(key, store);
    return result;
  };

  return [store, setStore];
};

/**
 * Creates a reactive query that watches multiple localStorage keys.
 *
 * @param keysFilter - Optional function to filter which keys to include
 * @param options - Configuration options for storage and record enhancement
 * @returns A tuple containing [stores, reload]
 *
 * @example
 * const [pads] = localStore.query(key => key.startsWith("pad:"));
 */
const query = <T extends Record<string, any>>(
  keysFilter?: KeyFilter,
  options: LocalStoreQueryOptions<T> & { serializer?: Serializer } = {},
): CreateLocalStoreQueryResult<T> => {
  const { storage = localStorage, enhanceRecord, serializer = defaultSerializer } = options;

  const loadStores = (): StoreItem<T>[] =>
    Object.keys(storage)
      .filter((key) => (keysFilter ? keysFilter(key) : true))
      .map((key) => {
        try {
          const stored = storage.getItem(key);
          if (!stored) return null;
          const parsed = serializer.deserialize(stored) as T;
          const item = { ...parsed, _key: key };
          return enhanceRecord ? enhanceRecord(item) : item;
        } catch {
          return null;
        }
      })
      .filter((item) => item !== null);

  const [stores, setStores] = createStore<Array<StoreItem<T>>>(loadStores());
  const reload = () => setStores(loadStores());

  const unsubscribe = subscribe(keysFilter || (() => true), () => reload());
  onCleanup(unsubscribe);

  return [stores, reload];
};

/**
 * Deletes a key from localStorage and notifies all stores/queries.
 */
const remove = (key: string, storage: Storage = localStorage): void => {
  storage.removeItem(key);
  notify(key, null);
};

/**
 * Directly modifies a localStorage key and notifies all stores/queries.
 */
const modify = <T extends Record<string, any>>(
  key: string,
  value: T | ((prev?: T) => T),
  options: { storage?: Storage; serializer?: Serializer } = {},
): void => {
  const { storage = localStorage, serializer = defaultSerializer } = options;
  if (typeof value === "function") {
    value = value(read<T>(key, { storage, serializer }) ?? undefined);
  }
  const storeValue = { ...value, _key: key };
  storage.setItem(key, serializer.serialize(storeValue));
  notify(key, storeValue);
};

/**
 * Checks if a key exists in localStorage.
 */
const exists = (key: string, storage: Storage = localStorage): boolean =>
  storage.getItem(key) !== null;

/**
 * Reads a value from localStorage.
 */
const read = <T extends Record<string, any>>(
  key: string,
  options: { storage?: Storage; serializer?: Serializer } = {},
): T | null => {
  const { storage = localStorage, serializer = defaultSerializer } = options;
  const item = storage.getItem(key);
  if (!item) return null;
  try {
    return serializer.deserialize(item);
  } catch (error) {
    console.error(`Failed to parse localStorage item "${key}":`, error);
    return null;
  }
};

export const localStore = {
  create,
  query,
  remove,
  modify,
  exists,
  read,
} as const;
