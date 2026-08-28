import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { err } from "@k2b/stdlib";
import { sendErrorMessage, webhookApiMessages } from "../../api/webhooks-messages";
import { webhookMessages } from "./webhook-messages";

const root = mkdtempSync(join(tmpdir(), "tools-network-i18n-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { speedTestMessages } = await import("./SpeedTest.island.tsx");

describe("Network tools i18n", () => {
  test("German catalogs are complete", () => {
    expect(webhookMessages.check()).toEqual([]);
    expect(speedTestMessages.check()).toEqual([]);
    expect(webhookApiMessages.check()).toEqual([]);
  });

  test("resolves representative German messages", () => {
    const { t } = webhookMessages.resolve(["de"]);
    expect(t.endpointCreated).toBe("Endpunkt erstellt.");
    expect(t.colTarget).toBe("Ziel");
    expect(t.requestCount({ count: 1 })).toBe("1 Anfrage");
    expect(t.requestCount({ count: 3 })).toBe("3 Anfragen");
    expect(t.endpointCount({ count: 1 })).toBe("1 Endpunkt");
    expect(t.endpointCount({ count: 5 })).toBe("5 Endpunkte");
    expect(t.deleteEndpoint({ name: "Stripe" })).toBe("Endpunkt Stripe löschen");

    const speedTest = speedTestMessages.resolve(["de"]).t;
    expect(speedTest.phaseDownload).toBe("Download wird gemessen");
  });

  test("English base output is unchanged", () => {
    const { t } = webhookMessages.resolve(["en"]);
    expect(t.deleteEndpoint({ name: "Stripe test" })).toBe("Delete endpoint Stripe test");
    expect(t.requestCount({ count: 1 })).toBe("1 request");
    expect(t.requestCountFiltered({ count: 4 })).toBe("4 requests filtered");
  });

  test("API-boundary errors keep stable codes with localized messages", () => {
    const { t } = webhookApiMessages.resolve(["de"]);
    const blocked = err.badInput(sendErrorMessage(t, "BLOCKED_TARGET"));
    expect(blocked.code).toBe("BAD_INPUT");
    expect(blocked.status).toBe(400);
    expect(blocked.message).toBe("Ziele in privaten, lokalen und link-lokalen Netzwerken sind blockiert.");

    const notFound = { ...err.notFound("Webhook endpoint"), message: t.endpointNotFound };
    expect(notFound.code).toBe("NOT_FOUND");
    expect(notFound.status).toBe(404);
    expect(notFound.message).toBe("Webhook-Endpunkt wurde nicht gefunden");

    const english = webhookApiMessages.resolve(["en"]).t;
    expect(english.endpointNotFound).toBe(err.notFound("Webhook endpoint").message);
  });

  test("de-CH falls back to de", () => {
    expect(webhookMessages.resolve(["de-CH"]).t.modeReceive).toBe("Empfangen");
    expect(speedTestMessages.resolve(["de-CH"]).t.startTest).toBe("Test starten");
    expect(webhookApiMessages.resolve(["de-CH"]).t.requestFailed).toBe("Anfrage fehlgeschlagen");
  });
});
