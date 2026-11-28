import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LINUX_IDENTITY_CONFIGURATION } from "@k2b/cloud/contracts";
import type { PosixCandidate } from "@k2b/cloud/services";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

// The Sign-in & security sections on v2 as the server renders them: the data of the first picture, no loader.
const root = mkdtempSync(join(tmpdir(), "core-signin-v2-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { LocaleProvider } = await import("@k2b/ui");
const { adminNavFixture } = await import("../admin-v2.fixture");
const { LinuxScreen, OperationsScreen, SigninFormScreen } = await import("./SigninScreen");
const { linuxQuery } = await import("./linux-query");
const { accountOperationsMessages } = await import("../settings/_components/account-operations-messages");
const { uploadedStatus } = await import("../settings/_components/sign-in-locations-fixture");

const nav = adminNavFixture("/admin/signin");
const render = (screen: () => JSX.Element, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return screen();
      },
    }),
  );
const noLoader = (html: string) => expect(html).not.toMatch(/data-k2-part="Loading"|aria-busy="true"/);
const alice: PosixCandidate = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "alice",
  displayName: "Alice",
  provider: "local",
  profile: "user",
  state: "ready",
  identity: null,
};
const linux = (enabled: boolean, items: PosixCandidate[] = [alice]) =>
  render(() =>
    createComponent(LinuxScreen, {
      nav,
      linux: {
        initial: {
          config: { ...DEFAULT_LINUX_IDENTITY_CONFIGURATION, enabled, rangeStart: 200000, rangeEnd: 299999 },
          items,
          nextCursor: null,
        },
        state: linuxQuery("en").parse("").state,
        after: null,
      },
    }),
  );

describe("Sign-in & security on the server", () => {
  test("operations hide the FreeIPA job when the integration is off and lead each job to its logs", () => {
    const operations = (freeIpaEnabled: boolean) => render(() => createComponent(OperationsScreen, { nav, freeIpaEnabled }));
    expect(operations(false)).not.toContain("FreeIPA account expiry");
    expect(operations(true)).toContain("FreeIPA account expiry");
    expect(operations(false)).toContain("Local full account expiry");
    expect(operations(false)).toContain("/admin/observability/jobs?search=auth%3A");
    expect(operations(false)).not.toContain("FreeIPA sync logs");
    expect(operations(true)).toContain("FreeIPA sync logs");
    expect(operations(false)).toContain("may restore their access");
    expect(operations(false)).toContain('href="/admin/observability/logs?source=auth:local-user:backfill"');
    noLoader(operations(true));
    expect(accountOperationsMessages.check()).toEqual([]);
  });

  test("a Linux setup that is off shows its way in, but no defaults or accounts", () => {
    const html = linux(false);
    expect(html).toContain("Set up local identities");
    expect(html).not.toContain("Home directory template");
    expect(html).not.toContain("<table");
    noLoader(html);
  });

  test("an active Linux setup shows its defaults, the filter bar and the accounts of the first page", () => {
    const html = linux(true);
    expect(html).toContain("Home directory template");
    expect(html).toContain("alice");
    expect(html).toContain("Linux attributes missing");
    expect(html).toContain('data-k2-part="FilterBar"');
    noLoader(html);
  });

  test("sign-in shows the app sign-in state and the sign-in locations from the server", () => {
    const html = render(() =>
      createComponent(SigninFormScreen, {
        nav,
        section: "signin",
        groups: ["user"],
        sections: [],
        entries: [],
        approvalState: "setup-required",
        signInLocations: { status: uploadedStatus, actorId: "11111111-1111-4111-8111-111111111111" },
      }),
    );
    expect(html).toContain("Sign-in locations");
    expect(html).toContain("GeoLite2-City");
    expect(html).toContain("Uploaded file");
    noLoader(html);
  });
});
