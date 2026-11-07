import { parseAppPwaQr } from "@k2b/cloud/app-pwa/browser";
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { DeviceSchema, PageSchema } from "../src/http";
import Kiosk from "../src/Kiosk";
import { type KioskApi, KioskFailure, KioskSnapshotSchema } from "../src/model";
import Staff, { type StaffApi } from "../src/Staff";

const root = document.getElementById("root");
const fixture = document.getElementById("fixture");
if (!root || !fixture?.textContent) throw new Error("Missing test fixture");
const initial = KioskSnapshotSchema.parse(JSON.parse(fixture.textContent));
const call = async (path: string, signal: AbortSignal, body?: unknown) => {
  const response = await fetch(`/fixture/${path}`, {
    method: body ? "POST" : "GET",
    signal,
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
  if (!response.ok) {
    if (response.status === 410) throw new KioskFailure("expired");
    if (response.status === 403) throw new KioskFailure("forbidden");
    if (response.status === 409) throw new KioskFailure("conflict");
    throw new KioskFailure("unavailable");
  }
  return response;
};
const api: KioskApi = {
  snapshot: async (signal) => KioskSnapshotSchema.parse(await (await call("snapshot", signal)).json()),
  acceptsQr: (text) => Boolean(parseAppPwaQr(text, "https://cloud.example.test", "/app/visit-demo/counter/")),
  scan: async (text, signal) => {
    await call("scan", signal, { text });
  },
  sign: async (attempt, input, signal) => {
    const response = await call("sign", signal, { attempt, input });
    if (location.search.includes("atomic")) return response.json();
  },
  reconcile: async (attempt, signal) => {
    const state = await (await call(`attempt/${attempt}`, signal)).text();
    return state === "completed" ? "completed" : state === "committed" ? "committed" : "absent";
  },
  end: async (attempt, signal) => {
    await call("end", signal, { attempt });
  },
};
const staffApi: StaffApi = {
  status: async (deviceId, signal) => DeviceSchema.parse(await (await call("devices/status", signal, { deviceId })).json()),
  list: async (signal, after) => PageSchema.parse(await (await call("devices/list", signal, after ? { after } : {})).json()),
  pair: async (requestId, name, signal) => (await call("devices/issue", signal, { requestId, name })).json(),
  revoke: async (deviceId, signal) => {
    await call("devices/revoke", signal, { deviceId });
  },
  visit: async (requestId, deviceId, signal) => (await call("visits/issue", signal, { requestId, deviceId })).json(),
};
render(
  () => (
    <LocaleProvider locale="de">
      {location.search.includes("staff") ? (
        <Staff initial={{ items: [], next: null }} api={staffApi} />
      ) : (
        <Kiosk initial={initial} api={api} />
      )}
    </LocaleProvider>
  ),
  root,
);
