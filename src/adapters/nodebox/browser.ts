/**
 * Nodebox runtime adapter (browser half).
 *
 * Nodebox runs in a cross-origin iframe served by CodeSandbox
 * (nodebox-runtime.codesandbox.io), installs dependencies from CodeSandbox's
 * package CDN when a command starts, and serves previews on
 * https://<id>-<port>.nodebox.codesandbox.io. The app frame therefore loads a
 * cross-origin URL; Playwright drives it like any other frame.
 */
import { Nodebox, type ShellProcess } from '@codesandbox/nodebox';
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, InstallReport } from '../../types.ts';

const PREVIEW_TIMEOUT_MS = 120_000;

export function createAdapter(): RuntimeAdapter {
  let runtime: Nodebox | null = null;
  let shell: ShellProcess | null = null;
  let frame: HTMLIFrameElement | null = null;

  return {
    name: 'nodebox',

    async mount(files: FileTree, ctx: AdapterContext) {
      frame = document.createElement('iframe');
      frame.id = 'nodebox-runtime';
      frame.title = 'Nodebox runtime';
      frame.style.display = 'none';
      document.body.append(frame);
      runtime = new Nodebox({ iframe: frame });
      await runtime.connect();
      const text: Record<string, string> = {};
      const binary: [string, Uint8Array][] = [];
      for (const [path, content] of Object.entries(files)) {
        if (typeof content === 'string') text[path] = content;
        else binary.push([path, Uint8Array.from(atob(content.base64), (c) => c.charCodeAt(0))]);
      }
      await runtime.fs.init(text);
      for (const [path, bytes] of binary) await runtime.fs.writeFile(path, bytes);
      if (!ctx.packageJson) throw new AdapterError('APP', 'package.json is missing or invalid');
    },

    async install(ctx: AdapterContext): Promise<InstallReport> {
      // Nodebox resolves and installs dependencies itself when a command starts
      // (from CodeSandbox's CDN); lockfiles are not consulted.
      return {
        resolution: Object.keys(ctx.packageJson?.dependencies ?? {}).length ? 'range' : 'none',
        lockfileHonored: false,
        dependencies: { ...ctx.packageJson?.dependencies },
        buildMs: null,
      };
    },

    async start(ctx: AdapterContext) {
      if (!runtime) throw new AdapterError('INTERNAL', 'mount() has not run');
      const script = ctx.packageJson?.scripts?.dev ? 'dev' : ctx.packageJson?.scripts?.start ? 'start' : null;
      if (!script) throw new AdapterError('APP', 'package.json has neither a "dev" nor a "start" script');
      shell = runtime.shell.create();
      shell.stdout.on('data', (d) => ctx.log('stdout', d.trimEnd()));
      shell.stderr.on('data', (d) => ctx.log('stderr', d.trimEnd()));
      // Nodebox has no npm binary: run the script's command line directly, as its docs do ("next dev").
      const line = ctx.packageJson!.scripts![script];
      const [command, ...args] = line.trim().split(/\s+/);
      if (/[|&;<>$`]/.test(line)) throw new AdapterError('UNSUPPORTED', `script "${script}" uses shell syntax: ${line}`);
      const exited = new Promise<never>((_, reject) => {
        shell!.on('exit', (code, error) => {
          const message = `"${line}" exited with code ${code}${error ? `: ${error.message}` : ''}`;
          ctx.log('stderr', message);
          reject(new AdapterError('INTERNAL', message));
        });
      });
      exited.catch(() => {});
      const proc = await shell.runCommand(command, args);
      if (!proc.id) throw new AdapterError('INTERNAL', 'Nodebox did not return a shell id');
      const preview = await Promise.race([runtime.preview.getByShellId(proc.id, PREVIEW_TIMEOUT_MS), exited]);
      return { url: preview.url };
    },

    async dispose() {
      await shell?.kill().catch(() => {});
      frame?.remove();
      runtime = null;
      shell = null;
    },
  };
}
