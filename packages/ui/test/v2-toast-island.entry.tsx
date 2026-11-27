import { createRoot } from "solid-js";
import { useToast } from "../src/v2";

// Another island: its own copy of `@k2b/ui` and no Workspace. `__k2ToastOther(text)` shows a toast from this copy.

declare global {
  interface Window {
    __k2ToastOther?: (text: string) => void;
  }
}

createRoot(() => {
  const toast = useToast();
  window.__k2ToastOther = (text) => void toast(text);
});
