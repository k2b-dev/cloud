import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createGeoIp, describeRequest } from "@k2b/cloud/server/request-context/index";
import * as logging from "../../services/logging";
import { mmdbFixture } from "./geoip.test-fixture";

const dirs: string[] = [];
let restoreLog: () => void;
beforeEach(() => {
  const log = spyOn(logging, "logger").mockReturnValue({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} });
  restoreLog = () => log.mockRestore();
});
afterEach(() => restoreLog());
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
test("describes a request using shared forwarding and request locale without returning an address", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-request-context-"));
  dirs.push(dir);
  const cityPath = join(dir, "city.mmdb");
  const asnPath = join(dir, "asn.mmdb");
  writeFileSync(cityPath, mmdbFixture("city"));
  writeFileSync(asnPath, mmdbFixture("asn"));
  const geoIp = createGeoIp({ cityPath, asnPath });
  const app = new Hono().get("/", (c) => c.json(describeRequest(c, { geoIp })));
  const headers = {
    "x-forwarded-for": "8.8.8.8, 10.0.0.1",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0",
    "accept-language": "de-AT",
  };
  const result = await (await app.request("/", { headers })).json();
  expect(result).toEqual({
    browser: "chrome",
    os: "windows",
    cityDatabase: true,
    asnDatabase: true,
    country: "AT",
    city: "Wien",
    network: "Example Net GmbH",
  });
  expect(JSON.stringify(result)).not.toContain("8.8.8.8");
  expect(result).not.toHaveProperty("ip");
  expect(result).not.toHaveProperty("prefix");
  const privateResult = await (await app.request("/", { headers: { ...headers, "x-forwarded-for": "10.0.0.1" } })).json();
  expect(privateResult).toMatchObject({ cityDatabase: true, asnDatabase: true, country: null, city: null, network: null });
});
test("lookup failure cannot fail the request", async () => {
  const app = new Hono().get("/", (c) =>
    c.json(
      describeRequest(c, {
        geoIp: {
          lookup() {
            throw new Error("fixture");
          },
          status() {
            return { city: null, asn: null };
          },
        },
      }),
    ),
  );
  expect(await (await app.request("/")).json()).toEqual({
    browser: "other",
    os: "other",
    cityDatabase: false,
    asnDatabase: false,
    country: null,
    city: null,
    network: null,
  });
});
