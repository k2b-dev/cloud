import { expect, test } from "bun:test";
import { readFingerprint } from "./ssh-fingerprint";

// FreeIPA's format: "%s %s (%s)" % (fingerprint_hex_sha256(), comment, keytype()), the comment only when the key has one
test("a FreeIPA fingerprint splits into the hash to copy, the owner's comment and the key type", () => {
  const hash = "SHA256:Kx9eM0vXr1q3Q2s1u8u0b3Jt2r4Wl0oYcQ7ZzT6p1aE";
  expect(readFingerprint(`${hash} root@db1.werkstatt.example (ssh-ed25519)`)).toEqual({
    hash,
    comment: "root@db1.werkstatt.example",
    type: "ssh-ed25519",
  });
  expect(readFingerprint(`${hash} Mia Muster laptop (ecdsa-sha2-nistp256)`)).toEqual({
    hash,
    comment: "Mia Muster laptop",
    type: "ecdsa-sha2-nistp256",
  });
  expect(readFingerprint(`${hash} (ssh-rsa)`)).toEqual({ hash, type: "ssh-rsa" });
  // something else is shown as it is, all of it as the value
  expect(readFingerprint(hash)).toEqual({ hash });
});
