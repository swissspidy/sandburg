/**
 * How a session launches Chromium: its flags, the proxy that blocks what escapes the egress gateway,
 * the extra CAs it pins, and the advice when the browser is missing.
 */
import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { LaunchOptions } from 'playwright-core';
import { SANDBOX_DOMAIN } from './host-server.ts';
import type { SessionOptions } from './session.ts';

/** Blocks any request that escapes the gateway: the proxy address is unroutable. */
const DEAD_PROXY = 'http://127.0.0.1:9';

/**
 * Playwright's own advice for a missing browser (`npx playwright install`) runs the latest
 * Playwright, whose Chromium build may not be the one the Playwright installed with Sandburg drives.
 */
export function missingBrowser(err: unknown): Error | null {
  if (!(err instanceof Error) || !err.message.includes("Executable doesn't exist")) return null;
  const { version } = createRequire(import.meta.url)('playwright-core/package.json') as { version: string };
  return new Error(`Chromium for Playwright ${version} is not installed. Run: npx playwright@${version} install chromium (on Linux, add --with-deps for its system libraries), or set SANDBURG_CHROMIUM to a Chromium binary.`);
}

/**
 * How long a WebAssembly function runs before V8 compiles optimized code for it. Every run compiles
 * the dev tools' WebAssembly builds (esbuild, SWC, rolldown) anew, in its own browser context. At
 * V8's default (13M, a rough count of bytes executed), esbuild's Go build had ~35 functions
 * optimized in a warm Vite run: 2.5 s of CPU on background threads, for a run that took 3.5 s, while
 * the runtime's thread waited for cores. At 100 times the default, only code that keeps running (a
 * long build, an edit loop) is optimized. Warm runs took 20-37% less time (Vite, Next.js, SvelteKit,
 * Angular); turning optimization off altogether (--liftoff-only) helped Vite but not Next.js' SWC.
 */
const WASM_TIERING_BUDGET = 1_300_000_000;

/** Chromium launch options. Exported so tests can check the network backstop without the gateway. */
export function launchOptions(options: SessionOptions): LaunchOptions {
  const ca = options.extraCaCerts === undefined ? (process.env.SANDBURG_EXTRA_CA_CERTS ?? process.env.NODE_EXTRA_CA_CERTS) : options.extraCaCerts;
  const spki = ca ? spkiHashes(ca) : [];
  return {
    headless: options.headless ?? true,
    args: [`--js-flags=--wasm-tiering-budget=${WASM_TIERING_BUDGET}`, ...(spki.length ? [`--ignore-certificate-errors-spki-list=${spki.join(',')}`] : [])],
    executablePath: options.executablePath ?? process.env.SANDBURG_CHROMIUM,
    // Default for contexts without their own egress-proxy credentials: only sandbox origins
    // bypass the dead proxy. Leading "<-loopback>" is required for
    // Chromium to honor the rule for *.localhost; it also keeps plain 127.0.0.1 blocked.
    proxy: { server: DEAD_PROXY, bypass: `<-loopback>,*.${SANDBOX_DOMAIN}` },
  };
}

/** base64 sha256 of each certificate's SubjectPublicKeyInfo, as Chromium's SPKI list expects. */
function spkiHashes(pemPath: string): string[] {
  const pem = readFileSync(pemPath, 'utf8');
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((c) =>
    createHash('sha256').update(new X509Certificate(c).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'),
  );
}
