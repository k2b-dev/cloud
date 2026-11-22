# Crypto Best Practices Guide

Comprehensive guide for using `crypto.*` from `@k2b/stdlib`.

---

## 1. Algorithm Selection

### Hashing: SHA-256 vs FNV-1a

| Function | Algorithm | Async | Collision-Resistant | Use Case |
|---|---|---|---|---|
| `crypto.common.hash()` | SHA-256 | Yes | Yes | Integrity checks, content addressing, fingerprinting |
| `crypto.common.fnv1aHash()` | FNV-1a | No (sync) | **No** | Hash map keys, cache keys, fast bucketing |

```ts
// Cryptographic hash -- use for anything security-related
const digest = await crypto.common.hash("user-input");

// Fast hash -- use for non-security lookups (e.g. sharding, cache keys)
const bucket = crypto.common.fnv1aHash("cache-key");
```

### Identifiers vs Secrets

| Function | Sortable | Human-friendly | Secret-safe | Use Case |
|---|---:|---:|---:|---|
| `crypto.common.ulid()` | Yes | Fair | No | Sortable entity IDs, log correlation, database keys |
| `crypto.common.uuid()` | No | No | No | Opaque public IDs where sort order is irrelevant |
| `crypto.common.readableId()` | No | Yes | No | Support codes, invite codes that are not security credentials |
| `crypto.common.generateKey()` | No | No | Yes | Reset tokens, API tokens, encryption keys |

```ts
const id = crypto.common.ulid();
const orderedId = crypto.common.ulid({ monotonic: true });
const requestId = crypto.common.uuid();
const supportCode = crypto.common.readableId();
const token = crypto.common.generateKey();
```

ULIDs expose a millisecond timestamp in the first 10 characters. With `{ monotonic: true }`, same-millisecond suffixes are incremented. Use ULIDs for orderable identifiers, not for secrets.

### Asymmetric vs Symmetric Encryption

| Module | Algorithm | Best For |
|---|---|---|
| `crypto.asymmetric` | ECDSA (sign) + ECDH (encrypt) on P-256 | Cross-party communication, signatures, end-to-end encryption |
| `crypto.symmetric` | AES-256-GCM | Server-side storage, encrypting secrets at rest |

**Rule of thumb:** If sender and receiver are different entities, use `asymmetric`. If you control both sides (e.g. encrypt-then-store on your server), use `symmetric`.

### Symmetric: `stretched` vs Non-Stretched

| Mode | KDF | Speed | Use When |
|---|---|---|---|
| `stretched: true` (default) | PBKDF2, 100k iterations | Slow (~100ms) | Key is a **user password** (low entropy) |
| `stretched: false` | HKDF | Fast (~1ms) | Key is from `generateKey()` or another high-entropy source |

```ts
// User password -- PBKDF2 stretching protects against brute force
await crypto.symmetric.encrypt({ payload: "data", key: "user-password" });
// stretched: true is the default, no need to specify

// Server key -- HKDF is sufficient, skip the expensive stretching
const serverKey = crypto.common.generateKey(); // 256-bit hex
await crypto.symmetric.encrypt({ payload: "data", key: serverKey, stretched: false });
```

### TOTP 2FA Setup Flow

The TOTP module implements RFC 6238 (SHA-1, 6 digits, 30-second period). The setup flow is:

```ts
// Step 1: Create secret + provisioning URI
const { uri, secret } = await crypto.totp.create({
  label: "user@example.com",
  issuer: "MyApp",
});

// Step 2: Show QR code of `uri` to the user
// Note: qr lives behind the `/qr` subpath -- import { qr } from "@k2b/stdlib/qr"
const qrSvg = qr.toSvg(uri);

// Step 3: Store secret encrypted at rest (NEVER plaintext)
const encryptedSecret = await crypto.symmetric.encrypt({
  payload: secret,
  key: serverKey,
  stretched: false,
});
// Save encryptedSecret to database

// Step 4: On login, verify the user's 6-digit code
const decryptedSecret = await crypto.symmetric.decrypt({
  payload: encryptedSecret,
  key: serverKey,
});
const valid = await crypto.totp.verify({ token: "123456", secret: decryptedSecret });
if (!valid) {
  // reject login
}
```

---

## 2. Key Management

### Key Format

Asymmetric keys use a versioned prefix format that encodes both ECDSA and ECDH keys:

- **Public:** `P01:<ecdsa-public>:<ecdh-public>` -- safe to share, used for verifying signatures and encrypting data
- **Private:** `S01:<ecdsa-private>:<ecdh-private>` -- must be kept secret, used for signing and decrypting

Each key pair is "hybrid": a single `generate()` call produces keys for both signing (ECDSA) and encryption (ECDH).

```ts
const { privateKey, publicKey } = await crypto.asymmetric.generate();
// privateKey = "S01:base64...:base64..."
// publicKey  = "P01:base64...:base64..."
```

### Symmetric Key Generation

Use `generateKey()` for high-entropy symmetric keys. Never use `readableId()`, `uuid()`, or `ulid()` as encryption keys.

```ts
const key = crypto.common.generateKey();     // 64-char hex string (256-bit)
const key128 = crypto.common.generateKey(16); // 32-char hex string (128-bit)
```

### Storage Rules

| Key Type | Safe Storage | Unsafe Storage |
|---|---|---|
| Private keys (`S01:...`) | Server-side DB, encrypted at rest, HSM | localStorage, cookies, client-side JS |
| Symmetric server keys | Environment variables, secret manager | Source code, client-side bundle |
| TOTP secrets | DB column encrypted with server key | Plaintext DB column, localStorage |
| Public keys (`P01:...`) | Anywhere (they are public) | N/A |

---

## 3. Common Patterns

### Sign-Then-Verify with Replay Protection

Signatures include a nonce and timestamp for replay protection. The verifier checks that the signature is not older than `maxAge` (default: 1 hour).

```ts
// Sender
const { privateKey } = senderKeys;
const sig = await crypto.asymmetric.sign({ privateKey, message: "transfer:100:to:bob" });
// sig = { nonce, timestamp, signature }

// Send sig.nonce, sig.timestamp, sig.signature, and the message to the receiver

// Receiver
const valid = await crypto.asymmetric.verify({
  publicKey: senderPublicKey,
  signature: sig.signature,
  nonce: sig.nonce,
  timestamp: sig.timestamp,
  message: "transfer:100:to:bob",
  maxAge: 5 * 60_000, // 5 minutes (override the 1-hour default)
});
// valid = true or false (never throws)
```

### Encrypt-Then-Store for Sensitive Data

```ts
const serverKey = process.env.ENCRYPTION_KEY!; // from generateKey()

// Encrypt before writing to DB
const encrypted = await crypto.symmetric.encrypt({
  payload: JSON.stringify(sensitiveData),
  key: serverKey,
  stretched: false, // serverKey is high-entropy, no need for PBKDF2
});
await db.insert({ data: encrypted });

// Decrypt after reading from DB
const row = await db.findOne(id);
const decrypted = JSON.parse(
  await crypto.symmetric.decrypt({ payload: row.data, key: serverKey })
);
```

### Password Generation

`password` is a separate module from `crypto` for tree-shaking -- importing `crypto` does not pull in the 5KB EFF wordlist.

```ts
import { password } from "@k2b/stdlib";
```

Choose the right generator for the use case:

```ts
// Strong random password -- for system accounts, API credentials
password.random({ length: 32, symbols: true });
// "aB3k!Lm9xQr@2Wp5Nj7Ht#4Ys6Fv8Gd"

// Memorable password -- for user-facing passwords they need to type
password.memorable({ words: 4, capitalize: true, addNumber: true });
// "Correct-Horse-7-Battery-Staple"

// PIN -- for numeric verification codes
password.pin({ length: 6 });
// "384729"

// Strength analysis
password.strength("Correct-Horse-7-Battery-Staple");
// { entropy: 41.36, score: 3, label: "strong", crackTime: "centuries", feedback: [] }
```

### TOTP 2FA Integration

```ts
// Registration flow
async function enableTwoFactor(userId: string) {
  const { uri, secret } = await crypto.totp.create({
    label: user.email,
    issuer: "MyApp",
  });

  // Encrypt and store the secret
  const enc = await crypto.symmetric.encrypt({
    payload: secret, key: SERVER_KEY, stretched: false,
  });
  await db.updateUser(userId, { totpSecret: enc, totpEnabled: false });

  return { uri }; // client renders QR from uri
}

// Verification flow (called during login)
async function verifyTwoFactor(userId: string, token: string): Promise<boolean> {
  const user = await db.getUser(userId);
  const secret = await crypto.symmetric.decrypt({
    payload: user.totpSecret, key: SERVER_KEY,
  });
  return crypto.totp.verify({ token, secret });
}
```

---

## 4. Security Gotchas

### `readableId` is NOT for Tokens

`readableId()` uses a reduced alphabet (no ambiguous chars like 0/O, 1/l) and is designed for human-readable identifiers, not security tokens.

```ts
// WRONG -- predictable, low entropy
const token = crypto.common.readableId(); // "a3X-B7nm-4Kp-qR9v"

// RIGHT -- cryptographically random, high entropy
const token = crypto.common.generateKey(); // 64-char hex (256-bit)
```

### `ulid` is Sortable, Not Secret

`ulid()` creates sortable identifiers with 80 bits of crypto randomness, but the millisecond timestamp is visible in the first 10 characters. With `{ monotonic: true }`, same-millisecond suffixes are incremented and therefore partly predictable.

```ts
const id = crypto.common.ulid(); // good for sortable entity IDs

// RIGHT for reset/API tokens
const token = crypto.common.generateKey();
```

### `fnv1aHash` is NOT Collision-Resistant

FNV-1a is a fast hash for hash tables. It is trivially easy to find collisions. Never use it for integrity checks, signatures, or anything security-sensitive.

```ts
// WRONG -- easy to forge
const checksum = crypto.common.fnv1aHash(payload);

// RIGHT -- SHA-256, collision-resistant
const checksum = await crypto.common.hash(payload);
```

### TOTP Secrets Must Be Encrypted at Rest

The shared secret is equivalent to a password. If an attacker gets it, they can generate valid TOTP codes.

```ts
// WRONG
await db.insert({ totpSecret: secret }); // plaintext in DB

// RIGHT
const enc = await crypto.symmetric.encrypt({
  payload: secret, key: SERVER_KEY, stretched: false,
});
await db.insert({ totpSecret: enc });
```

### Signature `maxAge` Default is 1 Hour

The default `maxAge` for `verify()` is 3,600,000ms (1 hour). For time-sensitive operations (payments, auth tokens), use a shorter window. Clock skew tolerance is 30 seconds into the future.

```ts
// Default: signatures valid for 1 hour
await crypto.asymmetric.verify({ ...sig, message, publicKey });

// Tighter window for sensitive operations
await crypto.asymmetric.verify({ ...sig, message, publicKey, maxAge: 60_000 }); // 1 minute
```

### `verify()` Returns `false`, Never Throws

Both `crypto.asymmetric.verify()` and `crypto.totp.verify()` return `false` on any failure (bad key, expired, tampered, invalid Base32, crypto errors). They never throw exceptions. Always check the return value.

```ts
// WRONG -- this does nothing useful, verify never throws
try {
  await crypto.asymmetric.verify({ ...sig, message, publicKey });
} catch (e) {
  // This block never runs
}

// RIGHT
const valid = await crypto.asymmetric.verify({ ...sig, message, publicKey });
if (!valid) {
  return fail(err.unauthenticated("Invalid signature"));
}
```

### Asymmetric Encryption is Non-Deterministic

Each call to `crypto.asymmetric.encrypt()` generates an ephemeral key pair internally. The same plaintext encrypted twice will produce different ciphertexts. This is by design (IND-CPA security) but means you cannot compare ciphertexts for equality.

```ts
const a = await crypto.asymmetric.encrypt({ payload: "hello", publicKey });
const b = await crypto.asymmetric.encrypt({ payload: "hello", publicKey });
// a !== b (different every time)
```

### Symmetric `decrypt` Auto-Detects the KDF

You do not need to pass `stretched` when decrypting. The encrypted blob encodes which KDF was used (PBKDF2 or HKDF), and `decrypt` selects the right one automatically.

```ts
// Encrypt with stretched: false
const enc = await crypto.symmetric.encrypt({ payload: "data", key, stretched: false });

// Decrypt -- no stretched flag needed
const dec = await crypto.symmetric.decrypt({ payload: enc, key });
```
