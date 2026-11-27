/**
 * One SSH key fingerprint as FreeIPA writes it in `sshpubkeyfp`: `<SHA256 fingerprint>[ <comment>] (<key type>)`, such
 * as `SHA256:Kx… root@db1 (ssh-ed25519)` (`ipalib/util.py`, `convert_sshpubkey_post`). The hash is what a person
 * compares and copies; the key type names it; the comment is whatever the key's owner wrote.
 */
export const readFingerprint = (text: string): { hash: string; comment?: string; type?: string } => {
  const typed = /^(.*?)\s+\(([^()\s]+)\)$/.exec(text.trim());
  const [hash = "", ...rest] = (typed ? typed[1]! : text.trim()).split(/\s+/);
  const comment = rest.join(" ");
  return { hash, ...(comment ? { comment } : {}), ...(typed ? { type: typed[2]! } : {}) };
};
