import { LocaleProvider } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import type { AccessEntry } from "../contracts/shared";
import PermissionEditor from "./PermissionEditor";

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(() => {
  let saved: AccessEntry[] = ["Mara Lind", "Lea Sommer", "Jonas Weber"].map((displayName, index) => ({
    id: `access-${index}`,
    principal: { type: "user", userId: `user-${index}` },
    displayName,
    permission: "read",
    createdAt: "2026-10-15T07:00:00.000Z",
  }));
  const [data, setData] = createSignal(saved);
  const refetch = () => {
    // Like a consumer's query: fresh objects contain the saved level and another person's change.
    saved = saved.map((entry, index) => ({
      ...entry,
      principal: { ...entry.principal },
      ...(index === 2 ? { permission: "write" as const } : {}),
    }));
    setData(saved);
  };
  document.addEventListener("refetch-access", refetch);
  onCleanup(() => document.removeEventListener("refetch-access", refetch));
  return (
    <LocaleProvider locale="en">
      <Show when={data()}>
        {(entries) => (
          <PermissionEditor
            initialEntries={entries()}
            // Equal-width labels isolate pending-state layout from a normal change in label width.
            allowedLevels={[
              { level: "read", label: "Level 1" },
              { level: "write", label: "Level 2" },
            ]}
            allowAuthenticated={false}
            grantAccess={async () => {
              throw new Error("Not used");
            }}
            updateAccess={(id, permission) =>
              new Promise<void>((resolve) => {
                // Existing tests use this mark and event to control the save.
                document.documentElement.dataset.saving = "true";
                document.addEventListener(
                  "settle-access",
                  () => {
                    saved = saved.map((entry) => (entry.id === id ? { ...entry, permission } : entry));
                    delete document.documentElement.dataset.saving;
                    resolve();
                  },
                  { once: true },
                );
              })
            }
            revokeAccess={async () => {}}
          />
        )}
      </Show>
    </LocaleProvider>
  );
}, host);
