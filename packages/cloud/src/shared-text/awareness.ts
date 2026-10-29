import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { z } from "zod";

const unsigned = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positionId = z.strictObject({ client: unsigned, clock: unsigned });
const relativePosition = z
  .strictObject({
    type: positionId.nullable().optional(),
    tname: z.string().nullable().optional(),
    item: positionId.nullable().optional(),
    assoc: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine((position) => position.type != null || position.tname != null);
const stateSchema = z
  .strictObject({
    // Identity is supplied by the authenticated transport, never copied from here.
    user: z.unknown().optional(),
    cursor: z.strictObject({ anchor: relativePosition, head: relativePosition }).nullable().optional(),
  })
  .nullable();

export class InvalidSharedTextAwarenessError extends Error {
  constructor() {
    super("Invalid shared text awareness update");
    this.name = "InvalidSharedTextAwarenessError";
  }
}

const encode = (clientId: number, clock: number, state: unknown): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
};

/** One authorized connection, with an ID allocated uniquely by its transport. */
export const createTrustedTextAwareness = (config: {
  clientId: number;
  textName: string;
  user: { userId: string; name: string; color: string };
}) => {
  if (!Number.isSafeInteger(config.clientId) || config.clientId < 2 ** 32) throw new RangeError("Invalid server awareness ID");
  const user = { userId: config.user.userId, name: config.user.name, color: config.user.color };
  let localClientId: number | undefined;
  let clock = 0;
  let active = false;
  const next = (state: unknown): Uint8Array => {
    if (clock === Number.MAX_SAFE_INTEGER) throw new RangeError("Awareness clock exhausted");
    return encode(config.clientId, ++clock, state);
  };
  return {
    /** Validate one local state and replace its envelope and identity. Throws on invalid input. */
    publish(bytes: Uint8Array): Uint8Array {
      try {
        const decoder = decoding.createDecoder(bytes);
        if (decoding.readVarUint(decoder) !== 1) throw new InvalidSharedTextAwarenessError();
        const clientId = decoding.readVarUint(decoder);
        const clientClock = decoding.readVarUint(decoder);
        if (!Number.isSafeInteger(clientId) || !Number.isSafeInteger(clientClock)) throw new InvalidSharedTextAwarenessError();
        const state = stateSchema.parse(JSON.parse(decoding.readVarString(decoder)));
        if (decoder.pos !== bytes.length || (localClientId !== undefined && localClientId !== clientId))
          throw new InvalidSharedTextAwarenessError();
        if (
          state?.cursor &&
          [state.cursor.anchor, state.cursor.head].some((position) => position.tname !== config.textName || position.type != null)
        )
          throw new InvalidSharedTextAwarenessError();
        const result = next(state === null ? null : { user, writerId: clientId, cursor: state.cursor ?? null });
        localClientId = clientId;
        active = state !== null;
        return result;
      } catch {
        throw new InvalidSharedTextAwarenessError();
      }
    },
    /** Publish on leave/close, including when the browser cannot send its own null state. */
    remove(): Uint8Array | null {
      if (!active) return null;
      const result = next(null);
      active = false;
      return result;
    },
  };
};
