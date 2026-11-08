import { describe, expect, test } from "bun:test";
import type { PanelPageContext } from "@k2b/cloud/contracts";
import { createRoot } from "solid-js";
import {
  type AssistantPlaceView,
  conversationPlace,
  createPagePlace,
  panelFollowsPlace,
  placePolicyText,
  readAssistantPlace,
} from "./assistant-place";

const pageId = "88888888-8888-4888-8888-888888888888";
const ref = (id: string) => ({ type: "kontakt.conversation", id });
const context = (seq: number, id: string): PanelPageContext => ({ v: 1, seq, pageId, app: "kontakt", scope: ref(id) });
const available = (id: string, title: string, conversationId: string | null = null): AssistantPlaceView => ({
  state: "available",
  ref: ref(id),
  title,
  app: { id: "kontakt", name: "Kundenkontakt", icon: "ti ti-messages" },
  typeTitle: "Unterhaltung",
  tools: [],
  skills: [],
  starters: [],
  conversationId,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Gustav at a place", () => {
  test("the panel follows only while it shows nothing to lose (O1)", () => {
    expect(panelFollowsPlace({ conversationId: null, empty: true, atPlace: false })).toBe(true);
    expect(panelFollowsPlace({ conversationId: "Blank1", empty: true, atPlace: false })).toBe(true);
    expect(panelFollowsPlace({ conversationId: "Place1", empty: false, atPlace: true })).toBe(true);
    expect(panelFollowsPlace({ conversationId: "Steu42", empty: false, atPlace: false })).toBe(false);
  });

  test("a late answer for an earlier page changes nothing", async () => {
    const answers = new Map([
      ["u_marta", deferred<AssistantPlaceView>()],
      ["u_jonas", deferred<AssistantPlaceView>()],
    ]);
    const applied: string[] = [];
    await createRoot(async (dispose) => {
      const place = createPagePlace({
        context: null,
        initial: null,
        load: (target) => answers.get(target.id)!.promise,
        onPlace: (view) => applied.push(view.state === "available" ? view.title : view.state),
      });
      place.receive(context(1, "u_marta"));
      place.receive(context(2, "u_jonas"));
      answers.get("u_jonas")!.resolve(available("u_jonas", "Jonas Probe"));
      await settle();
      answers.get("u_marta")!.resolve(available("u_marta", "Marta Beispiel"));
      await settle();
      const view = place.view();
      expect(view?.state === "available" ? view.title : null).toBe("Jonas Probe");
      expect(applied).toEqual(["Jonas Probe"]);
      expect(place.state()).toBe("idle");
      dispose();
    });
  });

  test("a failed load says so, and the same page retries", async () => {
    let fail = true;
    await createRoot(async (dispose) => {
      const place = createPagePlace({
        context: null,
        initial: null,
        load: async (target) => {
          if (fail) throw new Error("unavailable");
          return available(target.id, "Marta Beispiel");
        },
      });
      place.receive(context(1, "u_marta"));
      await settle();
      expect(place.state()).toBe("failed");
      fail = false;
      place.retry();
      await settle();
      expect(place.state()).toBe("idle");
      expect(place.view()?.state).toBe("available");
      dispose();
    });
  });

  test("the first paint's place is kept for the same page; leaving the place clears it", async () => {
    let loads = 0;
    await createRoot(async (dispose) => {
      const place = createPagePlace({
        context: context(1, "u_marta"),
        initial: available("u_marta", "Marta Beispiel"),
        load: async (target) => {
          loads++;
          return available(target.id, "Marta Beispiel");
        },
      });
      place.receive(context(1, "u_marta"));
      place.receive(context(2, "u_marta"));
      expect(loads).toBe(0);
      place.receive({ v: 1, seq: 3, pageId, app: "kontakt" });
      expect(place.view()).toBeNull();
      dispose();
    });
  });

  test("the server's answer: no block and no consent both leave the normal panel", () => {
    expect(readAssistantPlace(ref("u_marta"), { state: "consent_required" })).toEqual({ state: "none", ref: ref("u_marta") });
    expect(readAssistantPlace(ref("u_marta"), { state: "none" })).toEqual({ state: "none", ref: ref("u_marta") });
    expect(
      readAssistantPlace(ref("u_marta"), { state: "unavailable", ref: ref("u_marta"), title: "Marta Beispiel", conversationId: "Pmarta" }),
    ).toMatchObject({ state: "unavailable", title: "Marta Beispiel", conversationId: "Pmarta" });
    expect(() => readAssistantPlace(ref("u_marta"), { state: "available", ref: ref("u_marta") })).toThrow();
    // An app that did not answer is a failed load, not lost access.
    expect(() =>
      readAssistantPlace(ref("u_marta"), { state: "unavailable", ref: ref("u_marta"), title: null, conversationId: null, retry: true }),
    ).toThrow();
  });

  test("a chat's place and a tool's policy read as the bar shows them", () => {
    expect(conversationPlace({ place: { ref: ref("u_marta"), title: "Marta Beispiel" } })?.title).toBe("Marta Beispiel");
    expect(conversationPlace({ place: null })).toBeNull();
    expect(conversationPlace({})).toBeNull();
    expect(placePolicyText({ silent: "shared" })).toEqual({ asks: "once", reach: "shared" });
    expect(placePolicyText({ ask: "sends" })).toEqual({ asks: "always", reach: null });
    expect(placePolicyText(null)).toEqual({ asks: null, reach: null });
  });
});
