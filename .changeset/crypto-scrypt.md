---
'sandburg': patch
---

node:crypto has `scrypt`, `scryptSync`, `hkdf`, `hkdfSync` and `getCurves`, as Node derives and lists them: an app that hashes passwords with scrypt or derives keys with HKDF (Auth.js) no longer fails with "is not a function". `timingSafeEqual` throws on inputs of different lengths as Node does; `getCiphers`, `getHashes` and `constants` list what works here instead of nothing; `createCipheriv` and `createDecipheriv` take a null IV for ECB modes, as Node requires.

node:crypto has `KeyObject`, `createSecretKey`, `createPublicKey` and `createPrivateKey` (RSA, EC on P-256, P-384, P-521 and secp256k1, and Ed25519 keys as PEM, DER, JWK or a certificate's), and `sign` and `verify` (PKCS#1 v1.5, PSS, ECDSA in DER or IEEE P1363, Ed25519), with `createSign`, `createVerify`, `publicEncrypt` and their kin taking KeyObjects: JWT libraries such as jsonwebtoken and jose's Node build sign and verify tokens. Encrypted private keys (a passphrase), DSA and RSA-PSS keys are not supported.
