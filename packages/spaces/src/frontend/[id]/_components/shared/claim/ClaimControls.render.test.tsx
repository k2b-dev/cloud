import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceItemClaim } from "@/contracts";

const root = mkdtempSync(join(tmpdir(), "spaces-claim-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: ClaimButton } = await import("./ClaimButton");
const { default: ClaimAvatar } = await import("./ClaimAvatar");
const { LocaleProvider } = await import("@k2b/ui");

const me = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
const claimedAt = "2026-09-26T08:00:00.000Z";
const ownClaim: SpaceItemClaim = {
  id: "55555555-5555-4555-8555-555555555555",
  actor: { kind: "user", id: me },
  displayName: "Valentin Kolb",
  avatarHash: "abc",
  claimedAt,
};
const otherClaim: SpaceItemClaim = { ...ownClaim, actor: { kind: "user", id: other }, displayName: "Mira Beck", avatarHash: null };
const botClaim: SpaceItemClaim = {
  ...ownClaim,
  actor: { kind: "service_account", id: other },
  displayName: "Task worker",
  avatarHash: null,
};

const noop = () => undefined;
const withLocale = (locale: string, render: () => JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return render();
      },
    }),
  );
const button = (props: Partial<Parameters<typeof ClaimButton>[0]>, locale = "en") =>
  withLocale(locale, () =>
    createComponent(ClaimButton, {
      claim: null,
      currentUserId: me,
      isAdmin: false,
      onClaim: noop,
      onRelease: noop,
      onTakeOver: noop,
      ...props,
    }),
  );
const avatar = (props: Partial<Parameters<typeof ClaimAvatar>[0]>, locale = "en") =>
  withLocale(locale, () => createComponent(ClaimAvatar, { claim: otherClaim, currentUserId: me, ...props }));

describe("Spaces claim controls", () => {
  test("offers I'm on it for an unclaimed task and release for the holder", () => {
    const claim = button({});
    expect(claim).toContain('data-spaces-claim-action="claim"');
    expect(claim).toContain("I'm on it");
    expect(claim).toContain('class="ti ti-player-play"');

    const release = button({ claim: ownClaim });
    expect(release).toContain('data-spaces-claim-action="release"');
    expect(release).toContain(">Release<");
    expect(release).not.toContain("I'm on it");

    expect(button({}, "de")).toContain("Ich übernehme");
    expect(button({ claim: ownClaim }, "de")).toContain(">Freigeben<");
  });

  test("hides the control for another account's claim unless the person is a Space admin", () => {
    expect(button({ claim: otherClaim })).toBe("");
    expect(button({ claim: botClaim })).toBe("");

    const takeOver = button({ claim: otherClaim, isAdmin: true });
    expect(takeOver).toContain('data-spaces-claim-action="take-over"');
    expect(takeOver).toContain(">Take over<");
    expect(button({ claim: botClaim, isAdmin: true }, "de")).toContain(">Übernehmen<");
  });

  test("renders a compact icon button with an accessible name and disabled, loading states", () => {
    const compact = button({ compact: true });
    expect(compact).toContain(`aria-label="I'm on it"`);
    expect(compact).toContain("k2b-icon-button");
    expect(compact).not.toContain(">I'm on it<");

    expect(button({ disabled: true })).toContain(" disabled");
    const loading = button({ loading: true, claim: ownClaim });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("ti-loader-2 animate-spin");
    expect(loading).toContain(" disabled");
  });

  test("shows the holder's avatar identically for people and service accounts", () => {
    const person = avatar({});
    expect(person).toContain("data-spaces-claim-badge");
    expect(person).toContain('title="Mira Beck is on it"');
    expect(person).toContain('aria-label="Mira Beck is on it"');
    expect(person).toContain("ring-[var(--k2b-success-text)]");
    expect(person).toContain("MB");
    expect(person).not.toContain("<img");

    const picture = avatar({ claim: { ...otherClaim, avatarHash: "rev1" } });
    expect(picture).toContain(`<img src="/api/accounts/users/${other}/avatar?rev=rev1"`);

    const bot = avatar({ claim: botClaim });
    expect(bot).toContain('class="ti ti-api"');
    expect(bot).toContain('title="Task worker is on it"');

    const own = avatar({ claim: ownClaim, showName: true }, "de");
    expect(own).toContain('data-own-claim="true"');
    expect(own).toContain('title="Du arbeitest daran"');
    expect(own).toContain(">Du arbeitest daran</span>");
  });
});
