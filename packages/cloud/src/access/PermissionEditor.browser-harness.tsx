import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import PermissionEditor from "./PermissionEditor";

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale="en">
      <PermissionEditor
        initialEntries={["Mara Lind", "Lea Sommer", "Jonas Weber"].map((displayName, index) => ({
          id: `access-${index}`,
          principal: { type: "user", userId: `user-${index}` },
          displayName,
          permission: "read",
          createdAt: "2026-10-15T07:00:00.000Z",
        }))}
        // Equal-width labels isolate pending-state layout from a normal change in label width.
        allowedLevels={[
          { level: "read", label: "Level 1" },
          { level: "write", label: "Level 2" },
        ]}
        allowAuthenticated={false}
        grantAccess={async () => {
          throw new Error("Not used");
        }}
        updateAccess={() =>
          new Promise<void>((resolve) => {
            // The test waits for this mark, so it does not depend on how the editor shows a pending change.
            document.documentElement.dataset.saving = "true";
            document.addEventListener(
              "settle-access",
              () => {
                delete document.documentElement.dataset.saving;
                resolve();
              },
              { once: true },
            );
          })
        }
        revokeAccess={async () => {}}
      />
    </LocaleProvider>
  ),
  host,
);
