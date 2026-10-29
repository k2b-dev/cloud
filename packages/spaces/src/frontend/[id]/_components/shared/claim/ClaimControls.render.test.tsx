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
      canTakeOver: false,
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
  kind: "user" as const,
  id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
  displayName: `Person ${index}`,
  avatarHash: null,
});
/** Accessible names of the rendered avatars in stack order. */
// An avatar is named by `aria-label` (initials) or by `alt` (a picture, such as a service account's robot).
const avatarNames = (html: string) => [...html.matchAll(/(?:aria-label|alt)="([^"]+)"/g)].map((match) => match[1]);
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

  test("hides the control for another account's claim unless the place offers a take-over", () => {
    expect(button({ claim: otherClaim })).toBe("");
    expect(button({ claim: botClaim })).toBe("");

    const takeOver = button({ claim: otherClaim, canTakeOver: true });
    expect(takeOver).toContain('data-spaces-claim-action="take-over"');
    expect(takeOver).toContain(">Take over<");
    expect(button({ claim: botClaim, canTakeOver: true }, "de")).toContain(">Übernehmen<");
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
      { props: { claim: otherClaim, canTakeOver: true }, locale: "en", label: "Take over" },
      { props: { claim: otherClaim, canTakeOver: true }, locale: "de", label: "Übernehmen" },
    ];
    for (const { props, locale, label } of cases) {
      const compact = button({ ...props, compact: true }, locale);
      expect(compact).toContain(`aria-label="${label}"`);
      expect(tooltipText(compact)).toBe(label);
      // Server HTML keeps the label as native title for a page that never hydrates; hydration replaces it with the tooltip.
      expect(compact).toContain(` title="${label}"`);
    }
    // The full-width button already shows its label and needs no tooltip.
    expect(button({})).not.toContain('role="tooltip"');
  });

  test("shows the holder's avatar identically for people and service accounts", () => {
    const person = avatar({});
    expect(person).toContain("data-spaces-claim-badge");
    expect(person).toContain('title="Mira Beck is on it"');
    expect(person).toContain('aria-label="Mira Beck is on it"');
    // The success ring and gap lie inside the avatar, which keeps the assignees' size.
    expect(person).toContain('data-size="xs"');
    expect(person).toContain('class="k2b-avatar "');
    expect(person).toContain('data-ring="success"');
    expect(person).not.toContain("border-2");
    expect(person).toContain("MB");
    expect(person).not.toContain("<img");

    const picture = avatar({ claim: { ...otherClaim, avatarHash: "rev1" } });
    expect(picture).toContain(`<img src="/api/accounts/users/${other}/avatar?rev=rev1"`);

    const bot = avatar({ claim: botClaim });
    // A service account shows its robot in a square, never a bare icon.
    expect(bot).toContain(`<img src="/api/accounts/users/${other}/avatar"`);
    expect(bot).toContain('data-shape="square"');
    expect(bot).toContain('title="Task worker is on it"');

    const own = avatar({ claim: ownClaim }, "de");
    expect(own).toContain('data-own-claim="true"');
    expect(own).toContain('title="Du arbeitest daran"');
    expect(own).toContain('alt="Du arbeitest daran"');
  });

  test("draws a person with the same initials as claim holder and as assignee", () => {
    expect(avatar({ claim: { ...otherClaim, displayName: "Peter Fox" } })).toContain(">PF</span>");
    expect(stack({ assignees: [{ ...person(1), displayName: "Peter Fox" }] })).toContain(">PF</span>");
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
    expect(deduplicated.match(/data-ring="success"/g)).toHaveLength(1);
    expect(deduplicated).toMatch(/data-ring="success"[^>]*aria-label="Mira Beck is on it"/);

    // Holder and assignees share one avatar size; only the holder has a success ring inside it.
    expect(claimed.match(/data-size="xs"/g)).toHaveLength(3);
    expect(claimed.match(/border-2 border-\[var\(--ui-surface\)\]/g)).toHaveLength(3);
    expect(claimed.match(/data-ring="success"/g)).toHaveLength(1);
    // The holder does not tuck under the next avatar, so the whole ring stays visible.
    expect(claimed).toContain('class="flex shrink-0 -space-x-1"');
    expect(claimed).toMatch(/data-spaces-claim-badge class="[^"]* me-0"/);

    // A service account or unassigned holder still shows on a card without assignees, and nothing hides at max 1.
    const bot = stack({ claim: botClaim });
    expect(avatarNames(bot)).toEqual(["Task worker is on it"]);
    expect(bot).not.toContain(">+");
    const tight = stack({ assignees: crowd.slice(0, 2), claim: otherClaim, max: 1 });
    expect(avatarNames(tight)).toEqual(["Mira Beck is on it"]);
    expect(tight).toContain(">+2</span>");
  });

  test("keeps a service account and an assignee with the same id as distinct avatars", () => {
    const html = stack({ claim: botClaim, assignees: [{ id: other, kind: "user" as const, displayName: "Mira Beck", avatarHash: null }] });
    expect(avatarNames(html)).toEqual(["Task worker is on it", "Mira Beck avatar"]);
    expect(html.match(/data-ring="success"/g)).toHaveLength(1);
    expect(html).toMatch(/alt="Task worker is on it"[^>]*data-ring="success"/);
    expect(html).not.toMatch(/data-ring="success"[^>]*aria-label="Mira Beck avatar"/);
    expect(html).not.toContain(">+");
  });

  test("renders an assigned service-account holder once in the working position", () => {
    const html = stack({
      claim: botClaim,
      assignees: [person(1), { id: botClaim.actor.id, kind: "service_account", displayName: "Task worker", avatarHash: null }],
    });
    expect(avatarNames(html)).toEqual(["Task worker is on it", "Person 1 avatar"]);
    expect(html.match(/data-ring="success"/g)).toHaveLength(1);
    expect(html).not.toContain(">+");
  });

  test("names people in stack order and includes holders outside the assignees", () => {
    const assignees = [person(1), person(2), { id: other, kind: "user" as const, displayName: "Mira Beck", avatarHash: null }];
    const assigned = stack({ assignees, claim: otherClaim, showNames: true });
    expect(assigned).toContain('title="Mira Beck, Person 1, Person 2"');
    expect(assigned).toContain(">Mira Beck, Person 1, Person 2</span>");
    const fallback = stack({ assignees: [person(1)], claim: botClaim, showNames: true });
    expect(fallback).toContain('title="Task worker, Person 1"');
    expect(fallback).toContain(">Task worker, Person 1</span>");
    expect(stack({ claim: botClaim, showNames: true })).toContain(">Task worker</span>");
  });
});
