import { appApproval } from "@k2b/cloud/browser/app-approval";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import type { Authenticator } from "./authenticator";
import { openDialog } from "./dialog";
import { Pairing, pairingDialogOptions } from "./Pairing";
import type { Binding, Enrollment } from "./storage";
import { storage } from "./storage";

const saved = new Map<string, Enrollment>();
const bindings: Binding[] = [];
Reflect.set(window, "savedBindings", bindings);
Reflect.set(window, "storeClaimFromAnotherTab", () => {
  for (const [id, enrollment] of saved)
    saved.set(id, { ...enrollment, comparison: "123456", deviceId: "22222222-2222-4222-8222-222222222222" });
});
Object.assign(storage, {
  createKey: appApproval.createKey,
  enrollment: async (id: string) => structuredClone(saved.get(id)),
  saveEnrollment: async (value: Enrollment) => {
    saved.set(value.id, structuredClone(value));
  },
  removeEnrollment: async (id: string) => {
    saved.delete(id);
  },
  hasEnrollments: async () => saved.size > 0,
  saveBinding: async (value: Binding) => {
    bindings.push(value);
  },
  reserve: async () => true,
  defer: async () => {},
});
Reflect.set(
  window,
  "openPairing",
  ({ label = "Hoffmann Druck", locale = "de", empty = false }: { label?: string; locale?: "en" | "de"; empty?: boolean } = {}) => {
    const payload = {
      protocol: "cloud-app-approval-v1" as const,
      issuer: "https://cloud.example.test",
      pairingId: "11111111-1111-4111-8111-111111111111",
      secret: "a".repeat(42) + "A",
      expiresAt: "2026-10-23T13:05:00.000Z",
      ...(label ? { label } : {}),
    };
    const noop = async () => {};
    const absent = async (): Promise<never> => {
      throw new Error("Unused fixture method");
    };
    const auth: Authenticator = {
      bindings: () => [],
      states: () => ({}),
      now: Date.now,
      online: () => true,
      storageError: () => false,
      stored: async () => undefined,
      account: absent,
      action: absent,
      act: noop,
      decideChange: noop,
      decide: noop,
      revoke: noop,
      syncPush: noop,
      forget: noop,
      rename: noop,
      client: (issuer, signal) => appApproval.connect({ issuer, authenticatorOrigin: location.origin, signal }),
      changed: async () => {},
    };
    void openDialog(
      (close) =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(Pairing, {
              auth,
              link: empty ? undefined : appApproval.createPairingLink(location.origin, payload),
              close,
            });
          },
        }),
      pairingDialogOptions,
    );
  },
);
