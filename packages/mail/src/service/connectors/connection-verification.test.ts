import { expect, spyOn, test } from "bun:test";
import { connectorCapabilitiesSchema, EMPTY_CONNECTOR_CAPABILITIES } from "../../contracts";
import { storedJmapDetection, withJmapDetection } from "./connection-verification";
import { imapSmtpConnector } from "./imap-smtp";
import type { JmapDetection } from "./jmap-client";
import * as jmapClient from "./jmap-client";

const host = "mail.example.invalid";

test("completed observations replace the value; unknown preserves only the same host", () => {
  for (const previous of [true, false, null]) {
    expect(storedJmapDetection("detected", previous)).toBe(true);
    expect(storedJmapDetection("absent", previous)).toBe(false);
    expect(storedJmapDetection("unknown", previous)).toBe(previous);
    expect(storedJmapDetection("unknown", previous, true)).toBeNull();
  }
  expect(storedJmapDetection("unknown")).toBeNull();
});

test("failed and unfinished probes never fail or delay connection verification", async () => {
  for (const probe of [
    async () => {
      throw new Error("probe failed");
    },
    async () => new Promise<JmapDetection>(() => {}),
  ]) {
    expect(await withJmapDetection(host, async () => "verified", { probe })).toEqual({ result: "verified", jmap: "unknown" });
  }
});

test("a completed probe receives no credentials and is retained", async () => {
  const result = await withJmapDetection(
    host,
    async () => {
      await Promise.resolve();
      return "verified";
    },
    {
      probe: async (...args) => {
        expect(args).toHaveLength(2);
        expect(args[0]).toBe(host);
        expect(args[1]).toBeInstanceOf(AbortSignal);
        return "detected";
      },
    },
  );
  expect(result).toEqual({ result: "verified", jmap: "detected" });
});

test("explicit refresh waits for a probe after limits have completed", async () => {
  const probe = Promise.withResolvers<JmapDetection>();
  const limits = Promise.withResolvers<string>();
  let finished = false;
  const work = withJmapDetection(host, () => limits.promise, { waitForProbe: true, probe: () => probe.promise }).then((value) => {
    finished = true;
    return value;
  });
  limits.resolve("limits");
  await limits.promise;
  await Promise.resolve();
  expect(finished).toBe(false);
  probe.resolve("detected");
  expect(await work).toEqual({ result: "limits", jmap: "detected" });
});

test("refresh deadline releases a hung probe without failing the limits", async () => {
  let expire: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    new Proxy(globalThis.setTimeout, {
      apply(target, receiver, args) {
        const [callback, delay] = args;
        if (delay === 5_000 && typeof callback === "function") expire = () => callback();
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  try {
    const work = withJmapDetection(host, async () => "limits", {
      waitForProbe: true,
      probe: async () => new Promise<JmapDetection>(() => {}),
    });
    expect(expire).toBeFunction();
    expire!();
    expect(await work).toEqual({ result: "limits", jmap: "unknown" });
    expect(
      await withJmapDetection(host, async () => "limits", {
        waitForProbe: true,
        probe: async () => {
          throw new Error("unavailable");
        },
      }),
    ).toEqual({ result: "limits", jmap: "unknown" });
  } finally {
    timer.mockRestore();
  }
});

test("connector capabilities contain no detection state", () => {
  expect(connectorCapabilitiesSchema.parse({ ...EMPTY_CONNECTOR_CAPABILITIES, jmap: true })).toEqual(EMPTY_CONNECTOR_CAPABILITIES);
});

test("a provider failure remains a failure and cancels its probe", async () => {
  let probeSignal: AbortSignal | undefined;
  await expect(
    withJmapDetection(
      host,
      async () => {
        throw new Error("IMAP unavailable");
      },
      {
        probe: async (_host, signal) => {
          probeSignal = signal;
          return new Promise<JmapDetection>(() => {});
        },
      },
    ),
  ).rejects.toThrow("IMAP unavailable");
  expect(probeSignal?.aborted).toBe(true);
});

test("the connector used by rediscovery never starts JMAP detection", async () => {
  const probe = spyOn(jmapClient, "probeJmap").mockResolvedValue("detected");
  try {
    // Endpoint policy rejects both transports before dialing; the real verify path still runs.
    await expect(
      imapSmtpConnector.verify({
        name: "Fixture",
        email: "reader@example.invalid",
        username: "reader",
        secret: { kind: "password", password: "fixture-only" },
        imap: { host: "127.0.0.1", port: 993, tlsMode: "implicit" },
        smtp: { host: "127.0.0.1", port: 587, tlsMode: "starttls" },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_TRANSPORT_VERIFICATION_FAILED" });
    expect(probe).not.toHaveBeenCalled();
  } finally {
    probe.mockRestore();
  }
});
