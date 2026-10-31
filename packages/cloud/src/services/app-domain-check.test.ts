import { expect, test } from "bun:test";
import { checkAppDomain } from "./app-domain-check";

const checkedAt = "2026-10-30T12:00:00.000Z";
const fixture = (failAt?: "dns" | "certificate" | "reachable") => {
  const calls: string[] = [];
  const run = async (step: string) => {
    calls.push(step);
    if (step === failAt) throw new Error(`${step} failed`);
  };
  const probe = () => {
    const values = ["fixed-challenge", "secret-answer"];
    return checkAppDomain("site.example.test", {
      now: () => new Date(checkedAt),
      nonce: () => values.shift()!,
      resolve: async () => {
        await run("dns");
        return [{ address: "203.0.113.8", family: 4 }];
      },
      certificate: async (_host, addresses, signal) => {
        expect(addresses).toEqual([{ address: "203.0.113.8", family: 4 }]);
        expect(signal.aborted).toBe(false);
        await run("certificate");
      },
      challenge: async (host, nonce, answer) => {
        expect(host).toBe("site.example.test");
        expect(nonce).toBe("fixed-challenge");
        // The stored answer never travels in the request path, so an echoing server cannot pass.
        expect(answer).toBe("secret-answer");
        await run("challenge");
        return () => run("cleanup");
      },
      reachable: async (_host, _addresses, nonce, answer) => {
        expect(nonce).toBe("fixed-challenge");
        expect(answer).toBe("secret-answer");
        await run("reachable");
      },
    });
  };
  return { probe, calls };
};

test("checks DNS, the host certificate and the gateway challenge in order and cleans up", async () => {
  const { probe, calls } = fixture();
  expect(await probe()).toMatchObject({ checkedAt, dns: { ok: true }, certificate: { ok: true }, reachable: { ok: true } });
  expect(calls).toEqual(["dns", "certificate", "challenge", "reachable", "cleanup"]);
});
test("a failed stage stops the check and leaves later stages explicitly unchecked", async () => {
  for (const step of ["dns", "certificate", "reachable"] as const) {
    const { probe, calls } = fixture(step);
    const status = await probe();
    expect(status[step]).toEqual({ ok: false, detail: `${step} failed` });
    if (step === "dns") {
      expect(calls).toEqual(["dns"]);
      expect(status.certificate).toBeNull();
    }
    if (step === "certificate") {
      expect(calls).toEqual(["dns", "certificate"]);
      expect(status.reachable).toBeNull();
    }
    if (step === "reachable") expect(calls.at(-1)).toBe("cleanup");
  }
});
test("empty DNS records stop before any TLS or HTTP request", async () => {
  let connected = false;
  const status = await checkAppDomain("missing.example.test", {
    now: () => new Date(checkedAt),
    resolve: async () => [],
    certificate: async () => {
      connected = true;
    },
  });
  expect(status.dns).toEqual({ ok: false, detail: "No A or AAAA records found" });
  expect(status.certificate).toBeNull();
  expect(connected).toBe(false);
});
