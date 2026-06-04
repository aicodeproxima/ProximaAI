// Regression check: the Edge function's session-token HMAC must match what the
// Postgres RPC `_sign_session_token` produces. The subtle invariant: pgcrypto's
// hmac(msg, key, 'sha256') uses the key as RAW TEXT bytes of the hex string —
// it does NOT hex-decode the key. The Edge function imports the hex STRING
// (UTF-8 bytes) as the HMAC key to match. This script proves both interpretations
// so a future refactor can't silently regress token verification.
//
// Usage (values pulled out-of-band; never commit them):
//   TOKEN="<token from _sign_session_token>" \
//   SIGNKEY="<app_secrets.session_signing_key.key>" \
//   node scripts/verify-hmac.mjs
//
// Expected output:
//   MATCH (key=hex-as-text bytes)  : true     <- the Edge function uses this
//   MATCH (key=hex-decoded bytes)  : false

import { webcrypto as crypto } from 'node:crypto';

const token = process.env.TOKEN;
const keyHex = process.env.SIGNKEY;
if (!token || !keyHex) {
  console.error('Set TOKEN and SIGNKEY env vars. See header.');
  process.exit(2);
}

const [subject, exp, sig] = token.split('.');
const msg = `${subject}.${exp}`;

async function hmacHex(message, keyBytes) {
  const ck = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(message));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const hexToBytes = (h) => new Uint8Array(h.match(/.{2}/g).map((x) => parseInt(x, 16)));

const asText = await hmacHex(msg, new TextEncoder().encode(keyHex));
const asDecoded = await hmacHex(msg, hexToBytes(keyHex));

console.log('subject                        :', subject);
console.log('MATCH (key=hex-as-text bytes)  :', asText === sig, '  <- Edge function uses this');
console.log('MATCH (key=hex-decoded bytes)  :', asDecoded === sig);
process.exit(asText === sig ? 0 : 1);
