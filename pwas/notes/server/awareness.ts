import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { z } from "zod";
import { NotesError } from "./errors";

const unsigned = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const position = z.strictObject({ client: unsigned, clock: unsigned });
const relative = z
  .strictObject({
    type: position.nullable().optional(),
    tname: z.literal("text"),
    item: position.nullable().optional(),
    assoc: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine((value) => value.type == null);
const clientState = z
  .object({
    user: z.object({ name: z.string().max(1024).optional() }).optional(),
    cursor: z.strictObject({ anchor: relative, head: relative }).nullable().optional(),
  })
  .nullable();
const colors = ["#2563eb", "#c026d3", "#0f766e", "#b45309", "#be123c", "#6d28d9"];
const encode = (id: number, clock: number, state: unknown) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, id);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
};

/** Display names remain explicitly unverified; IDs, clocks and colors belong to the socket. */
export class SocketAwareness {
  private clientId?: number;
  private clock = 0;
  current: Uint8Array | null = null;
  constructor(
    readonly id: number,
    private readonly readOnly: boolean,
  ) {}
  publish(bytes: Uint8Array): Uint8Array {
    if (bytes.byteLength > 4096) throw new NotesError("invalid_awareness");
    try {
      const decoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(decoder) !== 1) throw new Error();
      const clientId = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder); // Remote clocks never become the server clock.
      if (
        !Number.isSafeInteger(clientId) ||
        clientId < 0 ||
        clientId >= 2 ** 32 ||
        (this.clientId !== undefined && this.clientId !== clientId)
      )
        throw new Error();
      const state = clientState.parse(JSON.parse(decoding.readVarString(decoder)));
      if (decoder.pos !== bytes.length) throw new Error();
      const name =
        Array.from(
          (state?.user?.name ?? "")
            .normalize("NFKC")
            .replace(/[\p{Cc}\p{Cf}]/gu, "")
            .trim(),
        )
          .slice(0, 32)
          .join("") || "Gast";
      const trusted =
        state === null
          ? null
          : {
              user: { userId: String(this.id), name, color: colors[this.id % colors.length], unverified: true, readOnly: this.readOnly },
              writerId: clientId,
              cursor: this.readOnly ? null : (state.cursor ?? null),
            };
      this.clientId = clientId;
      const result = encode(this.id, ++this.clock, trusted);
      this.current = state === null ? null : result;
      return result;
    } catch {
      throw new NotesError("invalid_awareness");
    }
  }
  remove(): Uint8Array | null {
    if (!this.current) return null;
    this.current = null;
    return encode(this.id, ++this.clock, null);
  }
}
