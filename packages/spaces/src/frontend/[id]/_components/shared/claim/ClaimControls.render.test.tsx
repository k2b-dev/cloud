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
const { default: AssigneeAvatars } = await import("../AssigneeAvatars");
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
const stack = (props: Partial<Parameters<typeof AssigneeAvatars>[0]>) =>
  withLocale("en", () => createComponent(AssigneeAvatars, { assignees: [], currentUserId: me, max: 3, ...props }));
const person = (index: number) => ({
  id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
  displayName: `Person ${index}`,
  avatarHash: null,
});
/** Accessible names of the rendered avatars in stack order. */
const avatarNames = (html: string) => [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
/** The tooltip surface text rendered next to a control. */
const tooltipText = (html: string) => html.match(/role="tooltip"[^>]*>([^<]*)</)?.[1];

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
    expect(compact).not.toContain(">I'm on it</button>");

    expect(button({ disabled: true })).toContain(" disabled");
    const loading = button({ loading: true, claim: ownClaim });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("ti-loader-2 animate-spin");
    expect(loading).toContain(" disabled");
  });

  test("gives the compact button the shared tooltip with the same localized label as its accessible name", () => {
    const cases = [
      { props: {}, locale: "en", label: "I'm on it" },
      { props: {}, locale: "de", label: "Ich übernehme" },
      { props: { claim: ownClaim }, locale: "en", label: "Release" },
      { props: { claim: ownClaim }, locale: "de", label: "Freigeben" },
      { props: { claim: otherClaim, isAdmin: true }, locale: "en", label: "Take over" },
      { props: { claim: otherClaim, isAdmin: true }, locale: "de", label: "Übernehmen" },
    ];
    for (const { props, locale, label } of cases) {
      const compact = button({ ...props, compact: true }, locale);
      expect(compact).toContain(`aria-label="${label}"`);
      expect(tooltipText(compact)).toBe(label);
      expect(compact).not.toContain(" title=");
    }
    // The full-width button already shows its label and needs no tooltip.
    expect(button({})).not.toContain('role="tooltip"');
  });

  test("shows the holder's avatar identically for people and service accounts", () => {
    const person = avatar({});
    expect(person).toContain("data-spaces-claim-badge");
    expect(person).toContain('title="Mira Beck is on it"');
    expect(person).toContain('aria-label="Mira Beck is on it"');
    // The success ring is a border inside the avatar footprint, not a ring with an outside offset.
    expect(person).toContain('data-size="xs"');
    expect(person).toContain("border-2 border-[var(--k2b-success-text)]");
    expect(person).not.toContain("ring-");
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
    // Same row as an assignee: extra-small avatar, gap-2, plain text-sm name.
    expect(own).toContain("items-center gap-2");
    expect(own).toContain('<span class="min-w-0 flex-1 truncate text-sm">Du arbeitest daran</span>');
    expect(avatar({ showName: true })).toContain(">Mira Beck</span>");
  });

  test("leads the card avatar stack with the claim holder, once, and never folds them into the overflow", () => {
    const crowd = Array.from({ length: 12 }, (_, index) => person(index + 1));

    const unclaimed = stack({ assignees: crowd });
    expect(unclaimed).not.toContain("data-spaces-claim-badge");
    expect(avatarNames(unclaimed)).toEqual(["Person 1 avatar", "Person 2 avatar", "Person 3 avatar"]);
    expect(unclaimed).toContain(">+9</span>");

    // A holder who is not assigned takes the first slot; the stack keeps its size.
    const claimed = stack({ assignees: crowd, claim: otherClaim });
    expect(avatarNames(claimed)).toEqual(["Mira Beck is on it", "Person 1 avatar", "Person 2 avatar"]);
    expect(claimed).toContain(">+10</span>");

    // An assigned holder appears once, first, even when listed last among many assignees.
    const assignedHolder = { ...person(12), displayName: "Mira Beck" };
    const deduplicated = stack({
      assignees: [...crowd.slice(0, 11), assignedHolder],
      claim: { ...otherClaim, actor: { kind: "user", id: assignedHolder.id } },
    });
    expect(avatarNames(deduplicated)).toEqual(["Mira Beck is on it", "Person 1 avatar", "Person 2 avatar"]);
    expect(deduplicated).toContain(">+9</span>");

    // Holder and assignees share one avatar size; the holder swaps the surface border for the success ring.
    expect(claimed.match(/data-size="xs"/g)).toHaveLength(3);
    expect(claimed.match(/border-2 border-\[var\(--ui-surface\)\]/g)).toHaveLength(3);
    expect(claimed.match(/border-2 border-\[var\(--k2b-success-text\)\]/g)).toHaveLength(1);

    // A service account or unassigned holder still shows on a card without assignees, and nothing hides at max 1.
    const bot = stack({ claim: botClaim });
    expect(avatarNames(bot)).toEqual(["Task worker is on it"]);
    expect(bot).not.toContain(">+");
    const tight = stack({ assignees: crowd.slice(0, 2), claim: otherClaim, max: 1 });
    expect(avatarNames(tight)).toEqual(["Mira Beck is on it"]);
    expect(tight).toContain(">+2</span>");
  });
});
