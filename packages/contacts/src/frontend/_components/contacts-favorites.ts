import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import { readErrorMessage } from "./api";

const FAVORITE_EVENT = "contacts:favorite-changed";

type ContactFavoriteChange = {
  bookId: string;
  contactId: string;
  favorite: boolean;
};

export const contactFavoriteKey = (bookId: string, contactId: string): string => `${bookId}:${contactId}`;

export const createContactFavoriteProjection = (initialFavoriteKeys: () => readonly string[]) => {
  const [overrides, setOverrides] = createSignal(new Map<string, boolean>());

  return {
    apply: (change: ContactFavoriteChange) => {
      setOverrides((current) => {
        const next = new Map(current);
        next.set(contactFavoriteKey(change.bookId, change.contactId), change.favorite);
        return next;
      });
    },
    favoriteFor: (contact: { bookId: string; id: string }) => {
      const key = contactFavoriteKey(contact.bookId, contact.id);
      return overrides().get(key) ?? initialFavoriteKeys().includes(key);
    },
  };
};

export const createContactFavoriteMutationLifecycle = (initialSourceKey: string) => {
  let currentSourceKey = initialSourceKey;
  let inFlightSourceKey: string | null = null;

  return {
    sourceKey: () => currentSourceKey,
    busy: () => inFlightSourceKey !== null,
    begin: (sourceKey: string): boolean => {
      if (sourceKey !== currentSourceKey || inFlightSourceKey !== null) return false;
      inFlightSourceKey = sourceKey;
      return true;
    },
    switchSource: (sourceKey: string): boolean => {
      if (sourceKey === currentSourceKey) return false;
      const shouldAbort = inFlightSourceKey !== null;
      currentSourceKey = sourceKey;
      inFlightSourceKey = null;
      return shouldAbort;
    },
    settle: (sourceKey: string): boolean => {
      if (sourceKey !== currentSourceKey || inFlightSourceKey !== sourceKey) return false;
      inFlightSourceKey = null;
      return true;
    },
    owns: (sourceKey: string): boolean => sourceKey === currentSourceKey,
  };
};

export const saveContactFavorite = async (
  change: ContactFavoriteChange,
  abortSignal: AbortSignal,
  errorFallback = "Could not update favorite",
): Promise<void> => {
  const response = await apiClient.favorites[":bookId"][":contactId"].$put(
    {
      param: { bookId: change.bookId, contactId: change.contactId },
      json: { favorite: change.favorite },
    },
    { init: { signal: abortSignal } },
  );
  if (!response.ok) throw new Error(await readErrorMessage(response, errorFallback));
  window.dispatchEvent(new CustomEvent<ContactFavoriteChange>(FAVORITE_EVENT, { detail: change }));
};

export const listenForContactFavoriteChanges = (listener: (change: ContactFavoriteChange) => void): (() => void) => {
  const handler = (event: Event) => listener((event as CustomEvent<ContactFavoriteChange>).detail);
  window.addEventListener(FAVORITE_EVENT, handler);
  return () => window.removeEventListener(FAVORITE_EVENT, handler);
};
