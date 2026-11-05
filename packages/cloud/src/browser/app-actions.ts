import { insideMobileApp } from "./app-session";

const actionsKey = Symbol.for("@k2b/cloud/app-actions");
const shared: typeof globalThis & { [actionsKey]?: Set<object> } = globalThis;

/** Holds automatic app update reloads until this action ends. Call the returned function on every exit path. */
export const beginAppAction = (): (() => void) => {
  if (!insideMobileApp()) return () => {};
  shared[actionsKey] ??= new Set();
  const actions = shared[actionsKey];
  const action = {};
  actions.add(action);
  return () => {
    actions.delete(action);
  };
};

export const hasAppActions = (): boolean => (shared[actionsKey]?.size ?? 0) > 0;

/** Tracks writes through fetch without changing the global fetch or treating background GET reads as actions. */
export const fetchAppAction = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const finish = ["GET", "HEAD", "OPTIONS"].includes(method) ? () => {} : beginAppAction();
  try {
    return await fetch(input, init);
  } finally {
    finish();
  }
};
