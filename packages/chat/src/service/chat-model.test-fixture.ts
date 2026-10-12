import type { SystemMessage } from "./contracts";
import type { rng } from "./rng.test-fixture";

export type Participant = { joinedSeq: number; lastReadSeq: null };
export type ModelMessage = {
  id: string;
  seq: number;
  rev: number;
  author: string;
  kind: "text" | "system";
  body: string | null;
  system: SystemMessage | null;
};
type Permission = "read" | "write" | "admin";
export type ModelOperation =
  | { type: "send"; actor: string; clientId: string; body: string }
  | { type: "add"; actor: string; members: string[] }
  | { type: "remove"; actor: string; member: string }
  | { type: "leave"; actor: string; successor?: string }
  | { type: "details"; actor: string; details: { name?: string | null; icon?: string | null; purpose?: string | null } }
  | { type: "permission"; actor: string; member: string; permission: Permission };

// Trimmed V5 oracle: sending never creates or moves a participant row.
export class ChatModel {
  seqHead = 0;
  rev = 0;
  changedRev = 0;
  name: string | null = null;
  icon: string | null = null;
  purpose: string | null = null;
  members = new Map<string, Permission>();
  parts = new Map<string, Participant>();
  msgs: ModelMessage[] = [];
  byClientId = new Map<string, ModelMessage>();

  constructor(readonly names: Map<string, string>) {}
  private person(id: string) {
    return { id, name: this.names.get(id)! };
  }
  private append(author: string, body: string | null, system: SystemMessage | null): ModelMessage {
    const message: ModelMessage = {
      id: `m${this.msgs.length + 1}`,
      seq: ++this.seqHead,
      rev: ++this.rev,
      author,
      kind: system ? "system" : "text",
      body,
      system,
    };
    if (system) this.changedRev = this.rev;
    this.msgs.push(message);
    return message;
  }
  create(actor: string, members: string[]) {
    for (const id of new Set([actor, ...members])) {
      this.members.set(id, id === actor ? "admin" : "write");
      this.parts.set(id, { joinedSeq: 0, lastReadSeq: null });
    }
    return this.append(actor, null, { code: "conversation_created", params: {} });
  }
  apply(op: ModelOperation): ModelMessage | undefined {
    const permission = this.members.get(op.actor);
    if (!permission) return;
    switch (op.type) {
      case "send": {
        if (permission === "read") return;
        const key = `${op.actor}|${op.clientId}`;
        const existing = this.byClientId.get(key);
        if (existing) return existing;
        const message = this.append(op.actor, op.body, null);
        this.byClientId.set(key, message);
        return message;
      }
      case "details": {
        if (permission === "read") return;
        const params: Extract<SystemMessage, { code: "details_changed" }>["params"] = {};
        for (const field of ["name", "icon", "purpose"] as const) {
          const next = op.details[field];
          if (next !== undefined && next !== this[field]) {
            params[field] = next;
            this[field] = next;
          }
        }
        if (!Object.keys(params).length) return;
        return this.append(op.actor, null, { code: "details_changed", params });
      }
      case "add": {
        if (permission !== "admin") return;
        const added = [...new Set(op.members)].filter((id) => !this.members.has(id));
        if (!added.length) return;
        for (const id of added) {
          this.members.set(id, "write");
          this.parts.set(id, { joinedSeq: this.seqHead, lastReadSeq: null });
        }
        return this.append(op.actor, null, { code: "members_added", params: { members: added.map((id) => this.person(id)) } });
      }
      case "permission": {
        const before = this.members.get(op.member);
        if (permission !== "admin" || !before || before === op.permission) return;
        if (before === "admin" && op.permission !== "admin" && [...this.members.values()].filter((p) => p === "admin").length === 1) return;
        this.members.set(op.member, op.permission);
        return this.append(op.actor, null, {
          code: "permission_changed",
          params: { member: this.person(op.member), permission: op.permission },
        });
      }
      case "remove":
      case "leave": {
        const member = op.type === "leave" ? op.actor : op.member;
        if (op.type === "remove" && permission !== "admin") return;
        if (!this.members.has(member)) return;
        const others = [...this.members].filter(([id]) => id !== member);
        const lastManager = this.members.get(member) === "admin" && !others.some(([, p]) => p === "admin");
        if (op.type === "remove" && lastManager) return;
        if (op.type === "leave" && (!others.length || (op.successor && !others.some(([id]) => id === op.successor)))) return;
        const successor = op.type === "leave" ? op.successor : undefined;
        if (lastManager && !successor) return;
        if (lastManager && successor) this.members.set(successor, "admin");
        this.members.delete(member);
        this.parts.delete(member);
        return this.append(
          op.actor,
          null,
          op.type === "remove"
            ? { code: "member_removed", params: { member: this.person(member) } }
            : { code: "member_left", params: lastManager && successor ? { successor: this.person(successor) } : {} },
        );
      }
    }
  }
}

/** One random operation; the model decides whether it is allowed. */
export const randomOperation = (model: ChatModel, random: ReturnType<typeof rng>, people: string[], step: number): ModelOperation => {
  const actor = random.pick([...model.members.keys()])!;
  const member = random.pick(people)!;
  const manager = [...model.members].find(([, permission]) => permission === "admin")![0];
  switch (random.int(8)) {
    case 0:
      return { type: "add", actor: manager, members: [member] };
    case 1:
      return { type: "remove", actor: manager, member };
    case 2:
      return { type: "leave", actor, successor: manager === actor ? [...model.members.keys()].find((id) => id !== actor) : undefined };
    case 3:
      return {
        type: "details",
        actor,
        details: { name: random.int(2) ? `Chat ${random.int(3)}` : null, purpose: `Purpose ${random.int(3)}` },
      };
    case 4:
      return { type: "permission", actor: manager, member, permission: random.pick(["read", "write", "admin"] as const)! };
    case 5: {
      const retry = random.pick([...model.byClientId.keys()]);
      if (retry) {
        const [author, clientId] = retry.split("|");
        return { type: "send", actor: author!, clientId: clientId!, body: "retry has a different body" };
      }
    }
  }
  return { type: "send", actor, clientId: `k${step}`, body: `**Message ${step}** 😀` };
};
