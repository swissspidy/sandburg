import { createRequire } from 'node:module';
import ms from 'ms';

export const greet = (name) => `Hello, ${name}, for ${ms(60_000, { long: true })}`;
// The version package-lock.json locks (^2.1.0 would be 2.1.3 without it).
export const msVersion = createRequire(import.meta.url)('ms/package.json').version;
// The ms it uses: one copy for the whole monorepo when the ranges allow one.
export { default as ms } from 'ms';
