import { expect, spyOn, test } from "bun:test";
import {
  type ConnectorVerification,
  connectorCapabilitiesSchema,
  EMPTY_CONNECTOR_CAPABILITIES,
  type ProviderConnectionInput,
  unavailableProviderLimitSnapshot,
} from "../../contracts";
import { withJmapDetection } from "./connection-verification";

const input: ProviderConnectionInput = {
  name: "Fixture",
  email: "reader@example.invalid",
  username: "reader",
  secret: { kind: "password", password: "fixture" },
  imap: { host: "mail.example.invalid", port: 993, tlsMode: "implicit" },
  smtp: { host: "mail.example.invalid", port: 587, tlsMode: "starttls" },
};
const verified: ConnectorVerification = {
  authenticatedPrincipal: "reader",
  serverIdentity: {},
  capabilities: EMPTY_CONNECTOR_CAPABILITIES,
  accounts: [],
  limits: unavailableProviderLimitSnapshot("2026-11-19T00:00:00.000Z"),
};

test("a failed or unfinished probe never fails or delays successful IMAP verification", async () => {
  for (const probe of [
    async () => {
      throw new Error("probe failed");
    },
    async () => new Promise<boolean>(() => {}),
  ]) {
    const result = await withJmapDetection(input.imap.host, async () => verified, probe);
    expect(result).toEqual({ result: verified, jmap: false });
  }
});

test("discovery deadline expires while IMAP continues successfully", async () => {
  let expire: (() => void) | undefined;
  const realTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    new Proxy(realTimer, {
      apply(target, receiver, args) {
        const [callback, delay] = args;
        if (delay === 5_000 && typeof callback === "function") expire = () => callback();
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  try {
    const result = await withJmapDetection(
      input.imap.host,
      async () => {
        expect(expire).toBeFunction();
        expire!();
        return verified;
      },
      async () => new Promise<boolean>(() => {}),
    );
    expect(result.jmap).toBe(false);
    expect(result.result.authenticatedPrincipal).toBe("reader");
  } finally {
    timer.mockRestore();
  }
});

test("a completed positive probe is retained and receives no credential", async () => {
  let detected!: () => void;
  const ready = new Promise<void>((resolve) => {
    detected = resolve;
  });
  const result = await withJmapDetection(
    input.imap.host,
    async () => {
      await ready;
      await Promise.resolve();
      return verified;
    },
    async (...args) => {
      expect(args).toHaveLength(2);
      expect(args[0]).toBe(input.imap.host);
      expect(args[1]).toBeInstanceOf(AbortSignal);
      detected();
      return true;
    },
  );
  expect(result.jmap).toBe(true);
});

test("old stored capabilities remain valid and the optional hint survives parsing", () => {
  expect(connectorCapabilitiesSchema.parse(EMPTY_CONNECTOR_CAPABILITIES)).toEqual(EMPTY_CONNECTOR_CAPABILITIES);
  expect(connectorCapabilitiesSchema.parse({ ...EMPTY_CONNECTOR_CAPABILITIES, jmap: true }).jmap).toBe(true);
});

test("an IMAP failure remains a failure and cancels discovery", async () => {
  let probeSignal: AbortSignal | undefined;
  await expect(
    withJmapDetection(
      input.imap.host,
      async () => {
        throw new Error("IMAP unavailable");
      },
      async (_host, signal) => {
        probeSignal = signal;
        return new Promise<boolean>(() => {});
      },
    ),
  ).rejects.toThrow("IMAP unavailable");
  expect(probeSignal?.aborted).toBe(true);
});

test("caller cancellation also cancels the discovery branch", async () => {
  const controller = new AbortController();
  let probeSignal: AbortSignal | undefined;
  const result = await withJmapDetection(
    input.imap.host,
    async () => {
      controller.abort();
      return verified;
    },
    async (_host, signal) => {
      probeSignal = signal;
      return new Promise<boolean>(() => {});
    },
    controller.signal,
  );
  expect(probeSignal?.aborted).toBe(true);
  expect(result.jmap).toBe(false);
});
