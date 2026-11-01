import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import type {} from "./shared-text-offline.test-fixture";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "shared-text-offline.test-fixture.ts")],
    target: "browser",
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not build shared text offline fixture.");
  const script = await build.outputs[0]!.text();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) =>
      new URL(request.url).pathname === "/fixture.js"
        ? new Response(script, { headers: { "content-type": "text/javascript" } })
        : new Response('<!doctype html><title>Offline fixture</title><script src="/fixture.js"></script>', {
            headers: { "content-type": "text/html" },
          }),
  });
  browser = await launchBrowser();
});
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.stop(true);
  }
});

const identity = { userId: "user-1", draftId: "draft-1", generation: "generation-1" };
const ready = async (page: Page) => {
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForFunction(() => Boolean(window.sharedTextOfflineTest));
};
const fixture = async (run: (first: Page, second: Page) => Promise<void>) => {
  const context = await browser.newContext();
  try {
    const first = await context.newPage();
    const second = await context.newPage();
    const errors = [pageErrors(first), pageErrors(second)];
    await Promise.all([ready(first), ready(second)]);
    try {
      await run(first, second);
    } finally {
      for (const page of [first, second]) {
        expect(await page.evaluate(() => window.sharedTextOfflineTest.close())).toEqual({ databases: 0, channels: 0 });
      }
    }
    expect(errors).toEqual([[], []]);
  } finally {
    await context.close();
  }
};

test("reload restores complete draft state, including deletes and unconfirmed text; an echo retains it", () =>
  fixture(async (page) => {
    await page.evaluate(async (identity) => {
      const f = window.sharedTextOfflineTest;
      const session = await f.open(identity);
      f.sessions.set("draft", session);
      const doc = f.doc(101);
      try {
        doc.getText("codemirror").insert(0, "old body");
        doc.getText("subject").insert(0, "subject");
        doc.getMap("metadata").set("format", "plain");
        await session.save(f.Y.encodeStateAsUpdate(doc));
        doc.getText("codemirror").delete(0, 4);
        doc.getText("codemirror").insert(4, " unconfirmed");
        const state = f.Y.encodeStateAsUpdate(doc);
        await session.save(state);
        // A transport echo only applies Yjs state; it is not a durable acknowledgement.
        f.Y.applyUpdate(doc, state);
        if (!(await session.load())) throw new Error("Echo deleted saved input");
      } finally {
        doc.destroy();
      }
    }, identity);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.sharedTextOfflineTest));
    expect(
      await page.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const session = await f.open(identity);
        f.sessions.set("reloaded", session);
        const doc = f.doc(102, await session.load());
        try {
          return [doc.getText("codemirror").toString(), doc.getText("subject").toString(), doc.getMap("metadata").get("format")];
        } finally {
          doc.destroy();
        }
      }, identity),
    ).toEqual(["body unconfirmed", "subject", "plain"]);
  }));

test("a durable snapshot must cover deletes as well as structs, and match the exact identity", () =>
  fixture(async (page) => {
    expect(
      await page.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const session = await f.open(identity);
        f.sessions.set("draft", session);
        const doc = f.doc(201);
        try {
          doc.getText("codemirror").insert(0, "abc");
          const before = f.Y.encodeStateAsUpdate(doc);
          const vectorBefore = Array.from(f.Y.encodeStateVector(doc));
          doc.getText("codemirror").delete(1, 1);
          const after = f.Y.encodeStateAsUpdate(doc);
          await session.save(after);
          const vectorUnchanged = JSON.stringify(vectorBefore) === JSON.stringify(Array.from(f.Y.encodeStateVector(doc)));
          const uncovered = await session.acknowledgeSnapshot({ identity, state: before, durability: "durable" });
          const retained = Boolean(await session.load());
          const wrongGeneration = await session
            .acknowledgeSnapshot({ identity: { ...identity, generation: "other" }, state: after, durability: "durable" })
            .then(
              () => "accepted",
              () => "rejected",
            );
          const released = await session.acknowledgeSnapshot({ identity, state: after, durability: "durable" });
          return { vectorUnchanged, uncovered, retained, wrongGeneration, released, state: await session.load() };
        } finally {
          doc.destroy();
        }
      }, identity),
    ).toEqual({ vectorUnchanged: true, uncovered: false, retained: true, wrongGeneration: "rejected", released: true, state: null });
  }));

test("unmarked echoes and incomplete snapshots cannot release a saved empty draft's deletes", () =>
  fixture(async (page) => {
    expect(
      await page.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const session = await f.open(identity);
        f.sessions.set("draft", session);
        const doc = f.doc(250);
        try {
          doc.getText("codemirror").insert(0, "remove");
          const vector = f.Y.encodeStateVector(doc);
          doc.getText("codemirror").delete(0, 6);
          const full = f.Y.encodeStateAsUpdate(doc);
          await session.save(full);
          const echo = { identity, state: full, durability: "durable" as const };
          Reflect.deleteProperty(echo, "durability");
          const unmarked = await session.acknowledgeSnapshot(echo).then(
            () => "accepted",
            () => "rejected",
          );
          const incomplete = await session
            .acknowledgeSnapshot({ identity, state: f.Y.encodeStateAsUpdate(doc, vector), durability: "durable" })
            .then(
              () => "accepted",
              () => "rejected",
            );
          const restored = f.doc(251, await session.load());
          try {
            return {
              unmarked,
              incomplete,
              text: restored.getText("codemirror").toString(),
              deletes: f.Y.snapshot(restored).ds.clients.size,
              released: await session.acknowledgeSnapshot({ identity, state: full, durability: "durable" }),
            };
          } finally {
            restored.destroy();
          }
        } finally {
          doc.destroy();
        }
      }, identity),
    ).toEqual({ unmarked: "rejected", incomplete: "rejected", text: "", deletes: 1, released: true });
  }));

test("two independent tabs merge concurrent inserts and deletes without overwriting input", () =>
  fixture(async (first, second) => {
    const base = await first.evaluate(() => {
      const f = window.sharedTextOfflineTest;
      const doc = f.doc(300);
      try {
        doc.getText("codemirror").insert(0, "base");
        return Array.from(f.Y.encodeStateAsUpdate(doc));
      } finally {
        doc.destroy();
      }
    });
    for (const [page, client] of [
      [first, 301],
      [second, 302],
    ] as const) {
      await page.evaluate(
        async ({ identity, base, client }) => {
          const f = window.sharedTextOfflineTest;
          f.sessions.set("draft", await f.open(identity));
          const doc = f.doc(client, new Uint8Array(base));
          if (client === 301) doc.getText("codemirror").delete(0, 1);
          doc.getText("codemirror").insert(doc.getText("codemirror").length, client === 301 ? "A" : "B");
          f.docs.set("draft", doc);
        },
        { identity, base, client },
      );
    }
    await Promise.all(
      [first, second].map((page) =>
        page.evaluate(async () => {
          const f = window.sharedTextOfflineTest;
          await f.sessions.get("draft")!.save(f.Y.encodeStateAsUpdate(f.docs.get("draft")!));
        }),
      ),
    );
    for (const page of [first, second]) {
      expect(
        await page.evaluate(async () => {
          const f = window.sharedTextOfflineTest;
          const doc = f.doc(303, await f.sessions.get("draft")!.load());
          try {
            return doc.getText("codemirror").toString();
          } finally {
            doc.destroy();
          }
        }),
      ).toBe("aseAB");
    }
  }));

test("acknowledging concurrently with another tab's save never loses its newer input", () =>
  fixture(async (first, second) => {
    const base = await first.evaluate(async (identity) => {
      const f = window.sharedTextOfflineTest;
      const session = await f.open(identity);
      f.sessions.set("draft", session);
      const doc = f.doc(400);
      try {
        doc.getText("codemirror").insert(0, "base");
        const state = f.Y.encodeStateAsUpdate(doc);
        await session.save(state);
        return Array.from(state);
      } finally {
        doc.destroy();
      }
    }, identity);
    await second.evaluate(
      async ({ identity, base }) => {
        const f = window.sharedTextOfflineTest;
        f.sessions.set("draft", await f.open(identity));
        const doc = f.doc(401, new Uint8Array(base));
        doc.getText("codemirror").insert(4, " newer");
        f.docs.set("draft", doc);
      },
      { identity, base },
    );
    await Promise.all([
      first.evaluate(
        async ({ identity, base }) => {
          await window.sharedTextOfflineTest.sessions
            .get("draft")!
            .acknowledgeSnapshot({ identity, state: new Uint8Array(base), durability: "durable" });
        },
        { identity, base },
      ),
      second.evaluate(async () => {
        const f = window.sharedTextOfflineTest;
        await f.sessions.get("draft")!.save(f.Y.encodeStateAsUpdate(f.docs.get("draft")!));
      }),
    ]);
    expect(
      await first.evaluate(
        async ({ identity, base }) => {
          const f = window.sharedTextOfflineTest;
          const session = f.sessions.get("draft")!;
          const released = await session.acknowledgeSnapshot({ identity, state: new Uint8Array(base), durability: "durable" });
          const doc = f.doc(402, await session.load());
          try {
            return { released, text: doc.getText("codemirror").toString() };
          } finally {
            doc.destroy();
          }
        },
        { identity, base },
      ),
    ).toEqual({ released: false, text: "base newer" });
  }));

test("logout notifies sessions across tabs, erases every user generation, and preserves other users", () =>
  fixture(async (first, second) => {
    for (const page of [first, second]) {
      await page.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const doc = f.doc(501);
        try {
          doc.getText("codemirror").insert(0, "private");
          for (const [slot, ids] of [
            ["draft", identity],
            ["generation", { ...identity, generation: "generation-2" }],
            ["other-draft", { ...identity, draftId: "draft-2" }],
            ["other-user", { ...identity, userId: "user-2" }],
          ] as const) {
            const session = await f.open(ids);
            f.sessions.set(slot, session);
            await session.save(f.Y.encodeStateAsUpdate(doc));
          }
        } finally {
          doc.destroy();
        }
      }, identity);
    }
    await second.evaluate((userId) => window.sharedTextOfflineTest.logout(userId), identity.userId);
    for (const page of [first, second]) {
      await page.waitForFunction(() =>
        ["draft", "generation", "other-draft"].every((key) => window.sharedTextOfflineTest.sessions.get(key)!.signal.aborted),
      );
      expect(
        await page.evaluate(async (identity) => {
          const f = window.sharedTextOfflineTest;
          const existing = f.sessions.get("draft")!;
          const staleError = await existing.load().then(
            () => "accepted",
            (e: Error) => e.name,
          );
          const other = f.sessions.get("other-user")!;
          const otherRetained = !other.signal.aborted && Boolean(await other.load());
          const reopened = await f.open(identity);
          f.sessions.set("reopened", reopened);
          const empty = (await reopened.load()) === null;
          const db = await f.rawDatabase();
          try {
            const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
              const request = db.transaction("drafts").objectStore("drafts").getAllKeys();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            return { staleError, otherRetained, empty, keys };
          } finally {
            db.close();
          }
        }, identity),
      ).toEqual({
        staleError: "SharedTextOfflineLoggedOutError",
        otherRetained: true,
        empty: true,
        keys: [["user-2", "draft-1", "generation-1"]],
      });
    }
    // A delayed notification from the completed logout must not revoke a new login.
    const notifications = await first.evaluate(() => window.sharedTextOfflineTest.notifications());
    await second.evaluate(() => {
      const channel = new BroadcastChannel("cloud-shared-text-offline-logout");
      channel.postMessage({ userId: "user-1", epoch: 1 });
      channel.close();
    });
    await first.waitForFunction((before) => window.sharedTextOfflineTest.notifications() > before, notifications);
    expect(
      await first.evaluate(async () => {
        const session = window.sharedTextOfflineTest.sessions.get("reopened")!;
        await session.load();
        return session.signal.aborted;
      }),
    ).toBe(false);
  }));

test("transaction-local epoch fences a queued late save even with logout broadcasts suppressed", () =>
  fixture(async (first, second) => {
    await first.evaluate(async (identity) => {
      const f = window.sharedTextOfflineTest;
      f.sessions.set("draft", await f.open(identity));
      const doc = f.doc(601);
      doc.getText("codemirror").insert(0, "input");
      f.docs.set("draft", doc);
      f.suppressLogout();
    }, identity);
    await second.evaluate(() => window.sharedTextOfflineTest.holdWrites());
    await first.evaluate(() => {
      const f = window.sharedTextOfflineTest;
      f.pending.set(
        "early",
        f.sessions
          .get("draft")!
          .save(f.Y.encodeStateAsUpdate(f.docs.get("draft")!))
          .then(
            () => "saved",
            (e: Error) => e.name,
          ),
      );
    });
    await second.evaluate((userId) => {
      const f = window.sharedTextOfflineTest;
      f.pending.set(
        "logout",
        f.logout(userId).then(
          () => "logged-out",
          (e: Error) => e.name,
        ),
      );
    }, identity.userId);
    await second.waitForFunction(() => window.sharedTextOfflineTest.resources().writes === 2);
    await first.evaluate(() => {
      const f = window.sharedTextOfflineTest;
      f.pending.set(
        "late",
        f.sessions
          .get("draft")!
          .save(f.Y.encodeStateAsUpdate(f.docs.get("draft")!))
          .then(
            () => "saved",
            (e: Error) => e.name,
          ),
      );
    });
    await second.evaluate(() => window.sharedTextOfflineTest.releaseWrites());
    expect(await first.evaluate(() => window.sharedTextOfflineTest.pending.get("early"))).toBe("saved");
    expect(await second.evaluate(() => window.sharedTextOfflineTest.pending.get("logout"))).toBe("logged-out");
    expect(await first.evaluate(() => window.sharedTextOfflineTest.pending.get("late"))).toBe("SharedTextOfflineLoggedOutError");
    expect(
      await first.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const session = await f.open(identity);
        f.sessions.set("new-login", session);
        return { empty: (await session.load()) === null, oldRevoked: f.sessions.get("draft")!.signal.aborted };
      }, identity),
    ).toEqual({ empty: true, oldRevoked: true });
  }));

test("user, draft and generation keys are isolated and explicit forget discards only one generation", () =>
  fixture(async (page) => {
    expect(
      await page.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const first = await f.open(identity);
        f.sessions.set("first", first);
        const doc = f.doc(701);
        try {
          doc.getText("codemirror").insert(0, "first");
          await first.save(f.Y.encodeStateAsUpdate(doc));
          for (const [slot, ids] of [
            ["user", { ...identity, userId: "other" }],
            ["draft", { ...identity, draftId: "other" }],
            ["generation", { ...identity, generation: "other" }],
          ] as const) {
            const other = await f.open(ids);
            f.sessions.set(slot, other);
            if ((await other.load()) !== null) throw new Error("Identity leaked");
            await other.save(f.Y.encodeStateAsUpdate(doc));
          }
          await first.forget();
          return {
            empty: (await first.load()) === null,
            others: await Promise.all(["user", "draft", "generation"].map(async (slot) => Boolean(await f.sessions.get(slot)!.load()))),
          };
        } finally {
          doc.destroy();
        }
      }, identity),
    ).toEqual({ empty: true, others: [true, true, true] });
  }));

test("close aborts queued writes, rejects later operations, and closes every resource idempotently", () =>
  fixture(async (first, second) => {
    await first.evaluate(async (identity) => {
      const f = window.sharedTextOfflineTest;
      f.sessions.set("draft", await f.open(identity));
    }, identity);
    await second.evaluate(() => window.sharedTextOfflineTest.holdWrites());
    await first.evaluate(() => {
      const f = window.sharedTextOfflineTest;
      const doc = f.doc(801);
      const session = f.sessions.get("draft")!;
      try {
        f.pending.set(
          "save",
          session.save(f.Y.encodeStateAsUpdate(doc)).then(
            () => "saved",
            (e: Error) => e.name,
          ),
        );
      } finally {
        doc.destroy();
      }
      session.close();
      session.close();
    });
    await second.evaluate(() => window.sharedTextOfflineTest.releaseWrites());
    expect(
      await first.evaluate(async () => {
        const f = window.sharedTextOfflineTest;
        return {
          pending: await f.pending.get("save"),
          later: await f.sessions
            .get("draft")!
            .load()
            .then(
              () => "accepted",
              () => "rejected",
            ),
          resources: f.resources(),
        };
      }),
    ).toEqual({ pending: "AbortError", later: "rejected", resources: { databases: 0, channels: 0, writes: 1 } });
  }));

test("malformed input and actual IDB request failures reject without deleting earlier saved input", () =>
  fixture(async (page) => {
    expect(
      await page.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const session = await f.open(identity);
        f.sessions.set("draft", session);
        const doc = f.doc(901);
        try {
          doc.getText("codemirror").insert(0, "keep");
          const state = f.Y.encodeStateAsUpdate(doc);
          await session.save(state);
          const malformed = await session.save(new Uint8Array([255])).then(
            () => "accepted",
            () => "rejected",
          );
          const nativePut = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
            // add() on the existing key produces a genuine asynchronous ConstraintError.
            return this.name === "drafts" ? this.add(...args) : nativePut.apply(this, args);
          };
          let requestError: string;
          try {
            requestError = await session.save(state).then(
              () => "accepted",
              (e: Error) => e.name,
            );
          } finally {
            IDBObjectStore.prototype.put = nativePut;
          }
          const restored = f.doc(902, await session.load());
          try {
            return { malformed, requestError, text: restored.getText("codemirror").toString() };
          } finally {
            restored.destroy();
          }
        } finally {
          doc.destroy();
        }
      }, identity),
    ).toEqual({ malformed: "rejected", requestError: "ConstraintError", text: "keep" });
  }));

test("corrupt storage is observable and explicit forget permits recovery", () =>
  fixture(async (page) => {
    expect(
      await page.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const session = await f.open(identity);
        f.sessions.set("draft", session);
        const db = await f.rawDatabase();
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("drafts", "readwrite");
            tx.objectStore("drafts").put({ ...identity, state: new Uint8Array([255]) });
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          });
        } finally {
          db.close();
        }
        const error = await session.load().then(
          () => "accepted",
          () => "rejected",
        );
        await session.forget();
        return { error, state: await session.load() };
      }, identity),
    ).toEqual({ error: "rejected", state: null });
  }));

test("IDB and channel open failures reject observably with no memory fallback or leaked connection", () =>
  fixture(async (page) => {
    expect(
      await page.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const open = indexedDB.open;
        indexedDB.open = () => {
          throw new DOMException("Denied", "SecurityError");
        };
        let storageError: string;
        try {
          storageError = await f.open(identity).then(
            () => "accepted",
            (e: Error) => e.name,
          );
        } finally {
          indexedDB.open = open;
        }
        const channel = window.BroadcastChannel;
        Object.defineProperty(window, "BroadcastChannel", {
          configurable: true,
          writable: true,
          value: function () {
            throw new DOMException("Denied", "SecurityError");
          },
        });
        let channelError: string;
        try {
          channelError = await f.open(identity).then(
            () => "accepted",
            (e: Error) => e.name,
          );
        } finally {
          window.BroadcastChannel = channel;
        }
        return { storageError, channelError, resources: f.resources() };
      }, identity),
    ).toEqual({ storageError: "SecurityError", channelError: "SecurityError", resources: { databases: 0, channels: 0, writes: 0 } });
  }));

test("a real database version change invalidates sessions and closes their channels", () =>
  fixture(async (page) => {
    expect(
      await page.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const session = await f.open(identity);
        f.sessions.set("draft", session);
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("cloud-shared-text-offline", 2);
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
          request.onerror = () => reject(request.error);
        });
        return {
          aborted: session.signal.aborted,
          later: await session.load().then(
            () => "accepted",
            () => "rejected",
          ),
          resources: f.resources(),
        };
      }, identity),
    ).toEqual({ aborted: true, later: "rejected", resources: { databases: 0, channels: 0, writes: 0 } });
  }));

test("concurrent tabs retain the oldest input base together with merged bytes", () =>
  fixture(async (first, second) => {
    const initial = await first.evaluate(async (identity) => {
      const f = window.sharedTextOfflineTest;
      const session = await f.open(identity);
      f.sessions.set("base", session);
      const doc = f.doc(901);
      try {
        doc.getText("codemirror").insert(0, "A");
        const state = f.Y.encodeStateAsUpdate(doc);
        await session.save(state, "s6t.fixture.30");
        return Array.from(state);
      } finally {
        doc.destroy();
      }
    }, identity);
    await Promise.all(
      [first, second].map((page, index) =>
        page.evaluate(
          async ({ identity, initial, index }) => {
            const f = window.sharedTextOfflineTest;
            const session = await f.open(identity);
            f.sessions.set("writer", session);
            const doc = f.doc(902 + index, new Uint8Array(initial));
            try {
              doc.getText("codemirror").insert(1, index === 0 ? "B" : "C");
              await session.save(f.Y.encodeStateAsUpdate(doc), index === 0 ? "s6t.fixture.20" : "s6t.fixture.10");
            } finally {
              doc.destroy();
            }
          },
          { identity, initial, index },
        ),
      ),
    );
    expect(
      await first.evaluate(async () => {
        const f = window.sharedTextOfflineTest;
        const session = f.sessions.get("base")!;
        const pending = (await session.loadPending())!;
        const doc = f.doc(904, pending.state);
        try {
          const text = doc.getText("codemirror").toString();
          const invalid = await session.save(pending.state, "s6t.other.1").then(
            () => false,
            () => true,
          );
          const preserved = await session.loadPending();
          await session.save(pending.state, null);
          return {
            base: pending.baseCursor,
            letters: [...text].sort().join(""),
            invalid,
            preservedBase: preserved?.baseCursor,
            unknownBase: (await session.loadPending())?.baseCursor,
          };
        } finally {
          doc.destroy();
        }
      }),
    ).toEqual({ base: "s6t.fixture.10", letters: "ABC", invalid: true, preservedBase: "s6t.fixture.10", unknownBase: null });
  }));

test("pending generation discovery survives another tab clearing a marker before a queued save", () =>
  fixture(async (first, second) => {
    await first.evaluate(async (identity) => {
      const f = window.sharedTextOfflineTest;
      const session = await f.open(identity);
      f.sessions.set("original", session);
      const doc = f.doc(901);
      f.docs.set("original", doc);
      doc.getText("codemirror").insert(0, "saved");
      await session.save(f.Y.encodeStateAsUpdate(doc));
    }, identity);
    await second.evaluate(async (identity) => {
      const f = window.sharedTextOfflineTest;
      const session = await f.open(identity);
      f.sessions.set("offline", session);
      f.docs.set("offline", f.doc(902, await session.load()));
    }, identity);
    await first.evaluate(() => window.sharedTextOfflineTest.holdWrites());
    await first.evaluate((identity) => {
      const f = window.sharedTextOfflineTest;
      const acknowledgement = f.sessions
        .get("original")!
        .acknowledgeSnapshot({
          identity,
          state: f.Y.encodeStateAsUpdate(f.docs.get("original")!),
          durability: "durable",
        })
        .then(() => {
          localStorage.removeItem("pending-generation");
          return "acknowledged";
        });
      f.pending.set("acknowledgement", acknowledgement);
    }, identity);
    await second.evaluate(() => {
      const f = window.sharedTextOfflineTest;
      const doc = f.docs.get("offline")!;
      doc.getText("codemirror").insert(5, " offline");
      localStorage.setItem("pending-generation", "generation-1");
      f.pending.set(
        "save",
        f.sessions
          .get("offline")!
          .save(f.Y.encodeStateAsUpdate(doc))
          .then(() => "saved"),
      );
    });
    await first.evaluate(() => window.sharedTextOfflineTest.releaseWrites());
    await first.evaluate(() => window.sharedTextOfflineTest.pending.get("acknowledgement"));
    await second.evaluate(() => window.sharedTextOfflineTest.pending.get("save"));
    expect(await second.evaluate(() => localStorage.getItem("pending-generation"))).toBeNull();
    await second.reload();
    await second.waitForFunction(() => Boolean(window.sharedTextOfflineTest));
    expect(
      await second.evaluate(async (identity) => {
        const f = window.sharedTextOfflineTest;
        const current = await f.open({ ...identity, generation: "generation-2" });
        f.sessions.set("current", current);
        const generations = await f.generations(identity);
        const old = await f.open({ ...identity, generation: generations[0]! });
        f.sessions.set("old", old);
        const recovered = f.doc(903, await old.load());
        try {
          return {
            generations,
            text: recovered.getText("codemirror").toString(),
            anotherUser: await f.generations({ ...identity, userId: "other-user" }),
            anotherDraft: await f.generations({ ...identity, draftId: "other-draft" }),
          };
        } finally {
          recovered.destroy();
        }
      }, identity),
    ).toEqual({ generations: ["generation-1"], text: "saved offline", anotherUser: [], anotherDraft: [] });
  }));
