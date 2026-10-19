import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import Devices from "./Devices.island";
import Pairing from "./Pairing.island";

/** Renders the real device list or a resumed pairing for a browser test, which answers the app approval API with invented data. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const userId = "00000000-0000-4000-8000-000000000042";
const mode = new URLSearchParams(location.search).get("mode");
// A pairing that the phone has claimed already; the dialog resumes it and reads its state at once.
if (mode === "pair")
  sessionStorage.setItem(
    `cloud.app-pairing:${userId}:${userId}`,
    // real clock: the dialog counts this expiry down on the page's real clock.
    JSON.stringify({ pairingId: "00000000-0000-4000-8000-000000000701", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
  );
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      {mode === "pair" ? (
        <Pairing
          userId={userId}
          actorId={userId}
          name="Jonas Beispiel"
          appOrigin="https://login.example.test"
          returnTo="/me/security"
          install={false}
        />
      ) : (
        <Devices
          availability="configured"
          pairing={{ userId, name: "Jonas Beispiel", appOrigin: "https://login.example.test" }}
          initial={{
            nextCursor: null,
            items: [
              {
                id: "00000000-0000-4000-8000-000000000601",
                name: "Jonas' iPhone 15 Pro",
                createdAt: "2026-09-01T10:00:00.000Z",
                lastUsedAt: "2026-10-16T09:14:00.000Z",
                revokedAt: null,
                assisted: false,
              },
            ],
          }}
        />
      )}
    </LocaleProvider>
  ),
  host,
);
