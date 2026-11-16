import { expect, test } from "bun:test";
import { LAUF_CSS, LAUF_SCRIPT, maintenanceGameMessages, offersMaintenanceGame } from ".";

test("catalog is complete", () => expect(maintenanceGameMessages.check()).toEqual([]));

test("only generic not-found and server-failure pages outside the mobile app and administration offer the game", () => {
  const page = { path: "/app/spaces/missing" };
  expect(offersMaintenanceGame(404, page)).toBe(true);
  expect(offersMaintenanceGame(500, page)).toBe(true);
  expect(offersMaintenanceGame(503, { ...page, layout: "minimal" })).toBe(true);
  for (const status of [400, 401, 403, 409, 410, 422, 429]) expect(offersMaintenanceGame(status, page)).toBe(false);
  expect(offersMaintenanceGame(404, { ...page, layout: "pwa" })).toBe(false);
  expect(offersMaintenanceGame(404, { ...page, title: "Payment failed" })).toBe(false);
  expect(offersMaintenanceGame(502, { ...page, description: "The booking was not saved." })).toBe(false);
  expect(offersMaintenanceGame(404, { ...page, action: { label: "Back to users", href: "/app/accounts" } })).toBe(false);
  expect(offersMaintenanceGame(404, { path: "/admin" })).toBe(false);
  expect(offersMaintenanceGame(500, { path: "/admin/apps" })).toBe(false);
  expect(offersMaintenanceGame(404, { path: "/administration" })).toBe(true);
});

test("the game is self-contained: no network, no sound, no storage beyond its record", () => {
  for (const forbidden of ["fetch(", "XMLHttpRequest", "WebSocket", "Audio", "import(", "http:", "https:", "url(", "eval("])
    expect(LAUF_SCRIPT + LAUF_CSS).not.toContain(forbidden);
  // One function expression: the gateway calls it from its own nonce'd script.
  expect(LAUF_SCRIPT.startsWith("(o)=>{")).toBe(true);
  expect(() => new Function(`return ${LAUF_SCRIPT}`)).not.toThrow();
});
