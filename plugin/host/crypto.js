/**
 * Deep Connect — key derivation and frame sealing.
 *
 * Two DSH installs signed in to the SAME DeepSeek account must arrive at the
 * same key without ever talking to each other, and the cloud relay must not be
 * able to derive it. So the account's own stable id is the only input:
 *
 *   channel = hex(SHA-256("dsh-deep-connect/channel/v1|" + secret))
 *   key     = PBKDF2-HMAC-SHA-256(secret, "dsh-deep-connect/key/v1", 210000, 32)
 *
 * `channel` is what the relay buckets on — it is a *hash*, so the relay never
 * learns the account id. `key` never leaves the machine.
 *
 * Threat model, stated honestly: the account id is issued by DeepSeek, is not
 * user-chosen and is not high-entropy. Deriving from it protects the RELAY and
 * the WIRE — the operator of a public relay holds only ciphertext and cannot
 * recover the plaintext without already knowing the account id. It does not
 * protect against someone who can already read your credential file; that
 * person owns the machine anyway. Forward secrecy needs out-of-band pairing
 * (a QR code or short code typed on both machines), which is deliberately left
 * for a later revision. A shared passphrase can be configured instead of the
 * account id, which raises the bar to "knows the passphrase".
 *
 * AES-256-GCM with a fresh random 96-bit nonce per frame, and the routing
 * metadata bound in as additional authenticated data so a relay cannot
 * retarget or replay a frame without the tag check failing.
 *
 * @module dsh-deep-connect/crypto
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Bumping this invalidates every stored key and requires a re-pair; it is also mixed into the KDF salt.
 * v3 is the "Pro" wire: stations (invite links), forced upgrade, and the new
 * channel/key domain separators. v1/v2 clients cannot decode a v3 frame at all,
 * which is how "older versions are invalid" is enforced on the wire rather than
 * by asking politely. */
export const PROTOCOL_VERSION = 3;
/** PBKDF2 cost. Chosen so a phone-class device derives in well under a second. */
const PBKDF2_ITERATIONS = 210_000;
/** AES-256-GCM: 12-byte nonce, 16-byte tag. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Domain separator for the relay-visible bucket id. */
const CHANNEL_LABEL = `dsh-deep-connect/channel/v${PROTOCOL_VERSION}|`;
/** Domain separator for the encryption key. */
const KEY_LABEL = `dsh-deep-connect/key/v${PROTOCOL_VERSION}|`;

/**
 * The relay-visible bucket id for one secret. Not secret-revealing in itself,
 * but still only ever sent to the relay, never to a peer or the browser.
 * @param secret - the account id, or the configured passphrase.
 * @returns 64 lowercase hex characters.
 */
export function channelFor(secret) {
  return createHash('sha256').update(CHANNEL_LABEL + secret).digest('hex');
}

/**
 * Derive the 32-byte frame key.
 *
 * PBKDF2 is synchronous and deliberately slow; callers derive ONCE at startup
 * and cache the result, never per frame.
 * @param secret - the account id, or the configured passphrase.
 * @returns a 32-byte key usable by {@link seal}/{@link open}.
 */
export function deriveKey(secret) {
  return new Uint8Array(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(KEY_LABEL, 'utf8'), Buffer.from('dsh-deep-connect', 'utf8'), 32));
}

/**
 * Slow-derive the frame key with PBKDF2, for the account-id case where the
 * input has low entropy. Prefer this over {@link deriveKey} for anything a
 * human chose or that comes from an identifier rather than a key store.
 * @param secret - the account id or passphrase.
 * @returns a 32-byte key.
 */
export async function deriveKeyPbkdf2(secret) {
  const { pbkdf2 } = await import('node:crypto');
  return new Promise((resolve, reject) => {
    pbkdf2(secret, KEY_LABEL, PBKDF2_ITERATIONS, 32, 'sha256', (error, key) => {
      if (error) reject(error);
      else resolve(new Uint8Array(key));
    });
  });
}

/**
 * A short human-comparable fingerprint of the key, so two devices can confirm
 * they derived the same one by reading six characters to each other. This is
 * the poor man's pairing check: it does not add secrecy, it catches a typo in a
 * passphrase before any data is exchanged.
 * @param key - the derived key.
 * @returns six uppercase base32-ish characters.
 */
export function fingerprint(key) {
  const digest = createHash('sha256').update(Buffer.from(key)).update('dsh-deep-connect/fingerprint').digest();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[digest[i] % alphabet.length];
  return out;
}

/**
 * Additional authenticated data binding one frame to its routing identity.
 *
 * The relay rewrites nothing but `seq`, and `seq` is only a per-recipient
 * delivery counter, so it is NOT part of the AAD: a relay that renumbered
 * frames must still fail the tag check if it touches `id`/`from`/`to`.
 * @param envelope - the routing fields of the frame.
 * @returns the AAD bytes.
 */
function aadFor(envelope) {
  return Buffer.from(`${envelope.id}|${envelope.from}|${envelope.to}|${PROTOCOL_VERSION}`, 'utf8');
}

/**
 * Seal one JSON payload into a base64 frame body.
 * @param key - the derived 32-byte key.
 * @param envelope - routing fields the ciphertext is bound to.
 * @param payload - any JSON-serializable value.
 * @returns base64 of `nonce || tag || ciphertext`.
 */
export function seal(key, envelope, payload) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce);
  cipher.setAAD(aadFor(envelope));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/**
 * Open one frame body.
 *
 * Returns `undefined` rather than throwing for every failure mode — a wrong
 * key, a tampered tag, truncated base64, non-JSON plaintext — because all of
 * them mean the same thing to a caller: this frame is not ours.
 * @param key - the derived 32-byte key.
 * @param envelope - the routing fields the ciphertext was bound to.
 * @param body - base64 frame body.
 * @returns the decoded payload, or `undefined`.
 */
export function open(key, envelope, body) {
  try {
    const raw = Buffer.from(String(body), 'base64');
    if (raw.length < NONCE_BYTES + TAG_BYTES + 1) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), raw.subarray(0, NONCE_BYTES));
    decipher.setAAD(aadFor(envelope));
    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Constant-time comparison for the shared relay token, so a wrong token cannot
 * be discovered a byte at a time.
 * @param a - first string.
 * @param b - second string.
 * @returns whether they are equal.
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * A short, non-guessable id for one frame.
 * @param prefix - a short tag naming the kind of frame.
 * @returns the frame id.
 */
export function frameId(prefix) {
  return `${prefix}-${randomBytes(9).toString('base64url')}`;
}
