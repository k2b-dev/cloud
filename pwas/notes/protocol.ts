import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/** y-websocket message types 0–3 stay wire-compatible; 4–7 add durable acknowledgements. */
export const message = { sync: 0, awareness: 1, auth: 2, queryAwareness: 3, update: 4, ack: 5, reject: 6, identity: 7 } as const;

export const frame = (type: number, write: (encoder: encoding.Encoder) => void): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
};
export const updateFrame = (id: string, bytes: Uint8Array): Uint8Array =>
  frame(message.update, (encoder) => {
    encoding.writeVarString(encoder, id);
    encoding.writeVarUint8Array(encoder, bytes);
  });
export const ackFrame = (id: string): Uint8Array => frame(message.ack, (encoder) => encoding.writeVarString(encoder, id));
export const rejectFrame = (id: string, code: string): Uint8Array =>
  frame(message.reject, (encoder) => {
    encoding.writeVarString(encoder, id);
    encoding.writeVarString(encoder, code);
  });
export const readReply = (bytes: Uint8Array): { type: "ack"; id: string } | { type: "reject"; id: string; code: string } | null => {
  const decoder = decoding.createDecoder(bytes);
  const type = decoding.readVarUint(decoder);
  if (type !== message.ack && type !== message.reject) return null;
  const id = decoding.readVarString(decoder);
  const reply =
    type === message.ack ? { type: "ack" as const, id } : { type: "reject" as const, id, code: decoding.readVarString(decoder) };
  if (decoder.pos !== bytes.length) throw new Error("invalid_frame");
  return reply;
};
