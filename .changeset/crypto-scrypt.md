---
'sandburg': patch
---

node:crypto has `scrypt`, `scryptSync`, `hkdf`, `hkdfSync` and `getCurves`, as Node derives and lists them: an app that hashes passwords with scrypt or derives keys with HKDF (Auth.js) no longer fails with "is not a function". `timingSafeEqual` throws on inputs of different lengths as Node does; `getCiphers`, `getHashes` and `constants` list what works here instead of nothing; `createCipheriv` and `createDecipheriv` take a null IV for ECB modes, as Node requires.
