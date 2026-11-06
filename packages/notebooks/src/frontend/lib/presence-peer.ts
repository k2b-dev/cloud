// One logical presence peer per page/tab. Transport leases remain independent,
// so reconnecting or closing one socket cannot delete the other socket's lease.
let peerId: string | undefined;
export const presencePeerId = (): string => (peerId ??= crypto.randomUUID());
