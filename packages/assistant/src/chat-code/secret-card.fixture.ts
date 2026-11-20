import { CODE_SECRET_ERRORS } from "@k2b/cloud/ai/ui";
import {
  createSecretRequest,
  type SecretRequestController,
  type SecretRequestEntry,
  type SecretRequestFailure,
  type SecretRequestPorts,
} from "./secret-request";

/** Invented data of mockup v4: one value that must never leave the field. */
export const SECRET_FIXTURE_VALUE = "pk_live_7f3Qm2Lx9aVt0eR";
const HOST = "https://api.paketdienst-beispiel.de";
const destination = { origin: HOST, pathPrefix: "/v1", headers: ["authorization"] };
const stored = (configured: boolean, code: boolean, binding = destination): SecretRequestEntry => ({
  revision: "11111111-1111-4111-8111-111111111111",
  configured,
  binding: code ? binding : { origin: HOST, pathPrefix: "/", headers: ["authorization"], prefix: "Bearer " },
  valueSetAt: code ? "2026-11-03T09:00:00Z" : null,
  valueSetBy: code ? { id: "22222222-2222-4222-8222-222222222222", name: "Lea Brandt" } : null,
});

export type SecretCardScene = {
  /** The mockup's scene, such as "c-ersetzen"; scenes beyond the mockup end in "+". */
  id: string;
  code: boolean;
  /** The step the timeline shows: the card while it is open, its outcome afterwards, or nothing. */
  step: "interaction" | "done" | "rejected" | "failed" | "not_run";
  /** The stored result after a reload; a live scene has none yet. */
  result?: unknown;
  /** Drives a fresh controller into the scene; without it, the scene is history only. */
  drive?: (controller: SecretRequestController, ports: ScenePorts) => Promise<unknown>;
  entry?: SecretRequestEntry | null;
};

type ScenePorts = {
  fail: (failure: SecretRequestFailure | null) => void;
  listFail: (failure: SecretRequestFailure | null) => void;
  setEntry: (entry: SecretRequestEntry | null) => void;
  /** Holds the next save until `release`, so the card stays in "saving". */
  hold: () => void;
  release: () => void;
};

const typed = async (controller: SecretRequestController, value = SECRET_FIXTURE_VALUE) => {
  await controller.start();
  controller.input(value);
};
const failedWith = (failure: SecretRequestFailure) => async (controller: SecretRequestController, ports: ScenePorts) => {
  await typed(controller);
  ports.fail(failure);
  await controller.submit();
};

/** Every state of mockup v4 with a card or an outcome line, in both cases, plus the states the mockup leaves out. */
export const SECRET_CARD_SCENES: readonly SecretCardScene[] = [
  ...[false, true].flatMap((code): SecretCardScene[] => {
    const p = code ? "c-" : "";
    return [
      { id: `${p}${code ? "neu" : "a-neu"}`, code, step: "interaction", drive: (c) => c.start() },
      { id: `${p}${code ? "tippt" : "a-tippt"}`, code, step: "interaction", drive: (c) => typed(c) },
      { id: `${p}${code ? "ersetzen" : "b-ersetzen"}`, code, step: "interaction", entry: stored(true, code), drive: (c) => c.start() },
      {
        id: `${p}${code ? "speichert" : "speichert"}`,
        code,
        step: "interaction",
        drive: async (c, ports) => {
          await typed(c);
          ports.hold();
          void c.submit();
        },
      },
      {
        id: `${p}gespeichert`,
        code,
        step: "done",
        result: { configured: true, name: code ? "Paketdienst_API" : "Paketdienst-API" },
        drive: async (c) => {
          await typed(c);
          await c.submit();
        },
      },
      {
        id: `${p}${code ? "ersetzt" : "b-ersetzt"}`,
        code,
        step: "done",
        entry: stored(true, code),
        result: { configured: true, name: code ? "Paketdienst_API" : "Paketdienst-API" },
        drive: async (c) => {
          await typed(c);
          await c.replace();
        },
      },
      {
        id: `${p}abgelehnt`,
        code,
        step: "rejected",
        result: { configured: false, name: code ? "Paketdienst_API" : "Paketdienst-API" },
        drive: async (c) => {
          await c.start();
          c.decline();
        },
      },
      {
        id: `${p}${code ? "leer" : "f-leer"}`,
        code,
        step: "interaction",
        drive: async (c) => {
          await c.start();
          await c.submit();
        },
      },
      {
        id: `${p}${code ? "ungueltig" : "f-ungueltig"}`,
        code,
        step: "interaction",
        drive: async (c) => {
          await typed(c, code ? "pk_live_7f3Qm2Lx9ä…" : "pk_live_7f3Qm2Lx9a\n…");
          await c.submit();
        },
      },
      {
        id: `${p}${code ? "recht" : "f-recht"}`,
        code,
        step: "failed",
        result: { failed: true, error: CODE_SECRET_ERRORS.accessLost },
        drive: failedWith(code ? { ok: false, code: "NOT_FOUND", status: 404 } : { ok: false, code: "HTTP_401", status: 401 }),
      },
      {
        id: `${p}${code ? "speichern" : "f-speichern"}`,
        code,
        step: "interaction",
        drive: failedWith(code ? { ok: false, code: "HTTP_422", status: 422 } : { ok: false, code: "UNAVAILABLE", status: null }),
      },
      {
        id: `${p}${code ? "konflikt" : "konflikt"}`,
        code,
        step: "interaction",
        entry: stored(true, code),
        drive: async (c, ports) => {
          await typed(c, "pk_live_9Rb2Kd81Lm");
          ports.fail({ ok: false, code: "CONFLICT", status: 409 });
          ports.setEntry({
            ...stored(true, code, { ...destination, pathPrefix: "/v2" }),
            revision: "33333333-3333-4333-8333-333333333333",
          });
          await c.replace();
        },
      },
      {
        id: `${p}anderswo`,
        code,
        step: "interaction",
        drive: async (c) => {
          await c.start();
          c.held();
        },
      },
      {
        id: `${p}abgelaufen`,
        code,
        step: "failed",
        result: { failed: true, error: CODE_SECRET_ERRORS.expired },
        drive: async (c) => {
          await typed(c);
          c.expire();
        },
      },
    ];
  }),
  {
    id: "c-unklar",
    code: true,
    step: "interaction",
    drive: failedWith({ ok: false, code: "UNAVAILABLE", status: null }),
  },
  { id: "c-geloescht", code: true, step: "interaction", entry: stored(false, true), drive: (c) => c.start() },
  {
    id: "c-nicht-verwaltet",
    code: true,
    step: "failed",
    result: { failed: true, error: CODE_SECRET_ERRORS.editorRequired },
    drive: async (c, ports) => {
      ports.listFail({ ok: false, code: "FORBIDDEN", status: 403 });
      await c.start();
    },
  },
  {
    id: "zu-lang+",
    code: false,
    step: "interaction",
    drive: async (c) => {
      await typed(c, "k".repeat(16001));
      await c.submit();
    },
  },
  { id: "c-bad-input+", code: true, step: "interaction", drive: failedWith({ ok: false, code: "BAD_INPUT", status: 400 }) },
  {
    id: "c-ausgang-unklar+",
    code: true,
    step: "failed",
    result: { failed: true, error: CODE_SECRET_ERRORS.unknown },
    drive: async (c, ports) => {
      await typed(c);
      ports.hold();
      void c.submit();
      // After the destination check, while the write is on its way.
      await new Promise((done) => setTimeout(done, 0));
      c.expire();
    },
  },
];

/** A controller with fake ports for one scene, driven into it. The ports keep the one value in memory only. */
export async function secretCardScene(scene: SecretCardScene) {
  let entry = scene.entry ?? null;
  let failure: SecretRequestFailure | null = null;
  let listFailure: SecretRequestFailure | null = null;
  let held: (() => void) | undefined;
  let holding = false;
  const saves: unknown[] = [];
  const ports: SecretRequestPorts = {
    async list() {
      return listFailure ?? { ok: true, entry, title: scene.code ? "Paketstatus abrufen" : null };
    },
    async check() {
      return true;
    },
    async save(input) {
      saves.push(input);
      if (holding) await new Promise<void>((done) => (held = done));
      const answer = failure;
      // A conflict answers once; the refreshed revision then saves.
      if (failure?.status === 409) failure = null;
      return answer ?? { ok: true };
    },
  };
  const controller = createSecretRequest(
    {
      name: scene.code ? "Paketdienst_API" : "Paketdienst-API",
      origin: HOST,
      header: "authorization",
      prefix: scene.code ? "" : "Bearer ",
      ...(scene.code ? { target: { code: "Abc234", pathPrefix: "/v1" } } : {}),
    },
    ports,
  );
  await scene.drive?.(controller, {
    fail: (next) => {
      failure = next;
    },
    listFail: (next) => {
      listFailure = next;
    },
    setEntry: (next) => {
      entry = next;
    },
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      held?.();
    },
  });
  return { controller, saves };
}

/** The arguments the timeline keeps for a scene's call: metadata only. */
export const secretSceneArgs = (code: boolean) => ({
  name: code ? "Paketdienst_API" : "Paketdienst-API",
  origin: HOST,
  header: "authorization",
  prefix: code ? "" : "Bearer ",
  ...(code ? { target: { code: "Abc234", pathPrefix: "/v1" } } : {}),
});
