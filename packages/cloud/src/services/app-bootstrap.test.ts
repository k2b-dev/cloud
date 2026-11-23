import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { BOOTSTRAP_REPLAY_RETENTION_SECONDS } from "../runtime/bootstrap-protocol";
import { redis, sql } from "../runtime/clients";
import {
  BootstrapProofUnavailableError,
  consumeBootstrapProof,
  RejectedBootstrapStart,
  recordRejectedBootstrapStart,
} from "./app-bootstrap";

useUnitClients();
const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const identity = {
  appId: "inventory",
  installationId: "11111111-1111-4111-8111-111111111111",
  keyId: "22222222-2222-4222-8222-222222222222",
};
beforeEach(() => setSystemTime(NOW));
afterEach(() => setSystemTime());

test("a replay claim uses one SET NX with TTL through expiry plus retention, without extending a repeated claim", async () => {
  const send = spyOn(redis, "send").mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
  try {
    const exp = NOW / 1000 + 30;
    expect(await consumeBootstrapProof(identity.keyId, "nonce", exp)).toBe(true);
    setSystemTime(NOW + 5000);
    expect(await consumeBootstrapProof(identity.keyId, "nonce", exp)).toBe(false);
    expect(send.mock.calls).toEqual([
      ["SET", [`cloud:app-proof:${identity.keyId}:nonce`, "1", "NX", "PX", String((30 + BOOTSTRAP_REPLAY_RETENTION_SECONDS) * 1000)]],
      ["SET", [`cloud:app-proof:${identity.keyId}:nonce`, "1", "NX", "PX", String((25 + BOOTSTRAP_REPLAY_RETENTION_SECONDS) * 1000)]],
    ]);
  } finally {
    send.mockRestore();
  }
});

test("Valkey errors and unexpected claim replies fail closed as unavailable", async () => {
  const send = spyOn(redis, "send").mockRejectedValueOnce(new Error("Valkey unavailable")).mockResolvedValueOnce("unexpected");
  try {
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(consumeBootstrapProof(identity.keyId, "nonce", NOW / 1000 + 30)).rejects.toBeInstanceOf(BootstrapProofUnavailableError);
  } finally {
    send.mockRestore();
  }
});

test("diagnostics skip SQL for consumed proofs and unavailable replay lookups", async () => {
  const send = spyOn(redis, "send").mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("Valkey unavailable"));
  let writes = 0;
  const db = new Proxy(sql, {
    apply() {
      writes++;
      return Promise.resolve([]);
    },
  });
  const rejection = new RejectedBootstrapStart(identity, "nonce", "revoked");
  try {
    await recordRejectedBootstrapStart(rejection, db);
    await recordRejectedBootstrapStart(rejection, db);
    expect(writes).toBe(0);
    expect(send.mock.calls).toEqual(Array.from({ length: 2 }, () => ["EXISTS", [`cloud:app-proof:${identity.keyId}:nonce`]]));
    send.mockResolvedValueOnce(0);
    await recordRejectedBootstrapStart(rejection, db);
    expect(writes).toBe(1);
  } finally {
    send.mockRestore();
  }
});
