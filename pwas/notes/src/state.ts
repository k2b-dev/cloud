import { toast } from "@k2b/ui";
import { createMemo, createRoot, createSignal } from "solid-js";
import { messages } from "./i18n";
import { openNotesStore, type NotesStore } from "./lib/local";
import type { NoteRecord, StoreErrorCode } from "./lib/model";
import { preferences } from "./prefs";
import { navigate } from "./router";

/** App-wide state: one store per tab, the current messages and the network state. */
export const app = createRoot(() => {
  const [store, setStore] = createSignal<NotesStore | null>(null);
  const [records, setRecords] = createSignal<NoteRecord[]>([]);
  const [online, setOnline] = createSignal(navigator.onLine);
  const [storeError, setStoreError] = createSignal<StoreErrorCode | null>(null);
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));

  const t = createMemo(() => messages.resolve([preferences.locale()]).t);

  void openNotesStore().then((opened) => {
    setRecords(opened.records());
    opened.subscribe(() => setRecords(opened.records()));
    opened.onError((code) => {
      setStoreError(code);
      if (code === "quota") showQuota();
      if (code === "unavailable") toast(t().unavailableBody, { title: t().unavailableTitle, duration: 0, iconClass: "ti ti-database-off" });
    });
    setStore(opened);
  });

  let quotaToast: { dismiss: () => void } | undefined;
  const showQuota = () => {
    quotaToast?.dismiss();
    quotaToast = toast.error(t().quotaBody, {
      title: t().quotaTitle,
      duration: 0,
      iconClass: "ti ti-database-x",
      action: { label: t().showStorage, onClick: () => void import("./views/Settings").then((module) => module.openSettings()) },
    });
  };

  return {
    store,
    /** The records of this browser, newest first; pending deletions stay visible until the server confirms. */
    records,
    ready: () => store() !== null,
    online,
    storeError,
    t,
    async createNote(text = "") {
      const current = store();
      if (!current) return;
      const id = await current.create(text);
      navigate(`/n/${id}`);
      return id;
    },
  };
});

export const t = () => app.t();
