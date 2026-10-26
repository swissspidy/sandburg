/**
 * How a session launches Chromium: its OS sandbox, its flags, the proxy that blocks what escapes the
 * egress gateway, the extra CAs it pins, and the advice when the browser is missing or its sandbox
 * cannot start.
 */
import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { LaunchOptions } from 'playwright-core';
import { SANDBOX_DOMAIN } from './host-server.ts';
import type { SessionOptions } from './session.ts';

/** Blocks any request that escapes the gateway: the proxy address is unroutable. */
const DEAD_PROXY = 'http://127.0.0.1:9';

/** The browser cannot start on this host as it is: the message says what to change (the CLI prints it alone). */
export class BrowserSetupError extends Error {
  override name = 'BrowserSetupError';
}

/**
 * Playwright's own advice for a missing browser (`npx playwright install`) runs the latest
 * Playwright, whose Chromium build may not be the one the Playwright installed with Sandburg drives.
 */
export function missingBrowser(err: unknown): BrowserSetupError | null {
  if (!(err instanceof Error) || !err.message.includes("Executable doesn't exist")) return null;
  const { version } = createRequire(import.meta.url)('playwright-core/package.json') as { version: string };
  return new BrowserSetupError(`Chromium for Playwright ${version} is not installed. Run: npx playwright@${version} install chromium (on Linux, add --with-deps for its system libraries), or set SANDBURG_CHROMIUM to a Chromium binary.`);
}

/**
 * Whether a session runs Chromium inside its OS sandbox: SessionOptions.browserSandbox, else on
 * unless $SANDBURG_NO_BROWSER_SANDBOX is 1. Playwright launches Chromium with --no-sandbox unless
 * asked otherwise; Sandburg asks, and never falls back on its own (launch fails instead, see
 * sandboxUnavailable): a run without the sandbox is one someone chose, and its result says so.
 */
export function browserSandbox(options: SessionOptions): boolean {
  return options.browserSandbox ?? process.env.SANDBURG_NO_BROWSER_SANDBOX !== '1';
}

/** What the CLI says of a session (and a run's summary) without the sandbox. */
export const NO_SANDBOX = "Chromium's OS sandbox is off (--no-browser-sandbox or SANDBURG_NO_BROWSER_SANDBOX=1)";

/**
 * The launch failed because Chromium's OS sandbox could not start (Playwright's own message for
 * it, or Chromium's in the browser's log): what to change, and the explicit opt-out.
 */
export function sandboxUnavailable(err: unknown): BrowserSetupError | null {
  if (!(err instanceof Error) || !/Chromium sandboxing failed|No usable sandbox|crbug\.com\/(?:638180|357670)/.test(err.message)) return null;
  const root = process.getuid?.() === 0 ? ' Sandburg is running as root, where Chromium cannot use it: run as another user.' : '';
  return new BrowserSetupError(
    `Chromium's OS sandbox could not start on this host.${root} Sandburg runs the browser sandboxed and does not fall back to running it without the sandbox. ` +
      'Make the sandbox available (on Linux it needs unprivileged user namespaces; Ubuntu 23.10 and later restrict them with AppArmor: sysctl kernel.apparmor_restrict_unprivileged_userns=0, or an AppArmor profile for the Chromium binary), ' +
      'or turn it off explicitly: --no-browser-sandbox, SANDBURG_NO_BROWSER_SANDBOX=1, or browserSandbox: false in SessionOptions. Results record it (environment.browserSandbox).',
    { cause: err },
  );
}

/**
 * Switches of Playwright's that Sandburg leaves out. --enable-unsafe-swiftshader lets web content
 * fall back to SwiftShader, a CPU implementation of the GPU, where Chromium otherwise refuses it: the
 * headless shell runs WebGL and WebGL 2 on SwiftShader (through ANGLE) without it (Chrome Headless
 * Shell 156: same renderer, same pixels), so it gave runs nothing but the exposure.
 */
const IGNORED_SWITCHES = ['--enable-unsafe-swiftshader'];

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

/**
 * Chromium features that reach the network from a sandbox's browser context on their own, through
 * its egress proxy, which refuses them, so that the network check counted them against the app:
 * PreconnectToSearch opens connections to the default search engine as a context starts (`CONNECT
 * www.google.com:443`, 4 per context), AutofillServerCommunication asks content-autofill.googleapis.com
 * about forms. Playwright turns off others of the kind (AimEnabled, OptimizationHints).
 */
const DISABLED_FEATURES = ['PreconnectToSearch', 'AutofillServerCommunication'];

/**
 * Each site in a renderer process of its own, frames included. Each run already has its own browser
 * context, so its own renderer; without this switch the headless shell keeps a cross-site frame in
 * its parent's renderer (Chrome Headless Shell 141 and 156), and with it a frame of another site is
 * isolated from the app's page as in desktop Chrome.
 *
 * Playwright's --disable-popup-blocking stays: the headless shell has no popup blocker (a script's
 * window.open, even one without a user gesture, opens a page with the switch or without it, 156), and
 * a popup opens in the run's own browser context, its requests policed by the run's egress proxy and
 * routes like the page's (ADR 0030). It matters only to a headed browser (`sandburg open`).
 */
const SITE_ISOLATION = '--site-per-process';

let playwrightFeatures: string[] | null | undefined;

/**
 * The features Playwright's own `--disable-features` switch turns off (chromiumSwitches in
 * playwright-core, which does not export them), or null if they cannot be read. Chromium takes only
 * the last `--disable-features`: one of ours alone would turn Playwright's back on.
 */
export function playwrightDisabledFeatures(): string[] | null {
  if (playwrightFeatures !== undefined) return playwrightFeatures;
  try {
    const bundle = readFileSync(createRequire(import.meta.url).resolve('playwright-core/lib/coreBundle'), 'utf8');
    const list = /\bdisabledFeatures = \[([^\]]*)\]/.exec(bundle)?.[1] ?? '';
    const names = [...list.replace(/\/\/.*$/gm, '').matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
    playwrightFeatures = names.length && bundle.includes(`"--disable-features=" + disabledFeatures.join(",")`) ? names : null;
  } catch {
    playwrightFeatures = null;
  }
  return playwrightFeatures;
}

/** Chromium launch options. Exported so tests can check the network backstop without the gateway. */
export function launchOptions(options: SessionOptions): LaunchOptions {
  const ca = options.extraCaCerts === undefined ? (process.env.SANDBURG_EXTRA_CA_CERTS ?? process.env.NODE_EXTRA_CA_CERTS) : options.extraCaCerts;
  const spki = ca ? spkiHashes(ca) : [];
  // Playwright's switch is replaced by one with its features and ours (unread: left as it is).
  const features = playwrightDisabledFeatures();
  return {
    headless: options.headless ?? true,
    chromiumSandbox: browserSandbox(options),
    args: [
      SITE_ISOLATION,
      `--js-flags=--wasm-tiering-budget=${WASM_TIERING_BUDGET}`,
      ...(spki.length ? [`--ignore-certificate-errors-spki-list=${spki.join(',')}`] : []),
      ...(features ? [`--disable-features=${[...features, ...DISABLED_FEATURES].join(',')}`] : []),
    ],
    ignoreDefaultArgs: [...IGNORED_SWITCHES, ...(features ? [`--disable-features=${features.join(',')}`] : [])],
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
