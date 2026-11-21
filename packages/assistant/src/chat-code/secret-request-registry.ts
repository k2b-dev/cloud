import type { SecretRequestController } from "./secret-request";

/**
 * Only this window's runtime registers controllers; no storage, URL or cross-window transport. A module of its own, so
 * the timeline finds a card's controller without loading the controller code into the first bundle.
 */
export type SecretRequestKey = { conversationId: string; turnId: string; callId: string };
const requestKey = (key: SecretRequestKey) => JSON.stringify([key.conversationId, key.turnId, key.callId]);
const requests = new Map<string, SecretRequestController>();
const observers = new Set<() => void>();
export const getSecretRequest = (key: SecretRequestKey) => requests.get(requestKey(key));
export const observeSecretRequests = (listener: () => void) => {
  observers.add(listener);
  return () => {
    observers.delete(listener);
  };
};
export function registerSecretRequest(key: SecretRequestKey, controller: SecretRequestController) {
  const id = requestKey(key);
  requests.set(id, controller);
  for (const observer of observers) observer();
  return () => {
    if (requests.get(id) === controller) requests.delete(id);
    for (const observer of observers) observer();
  };
}
