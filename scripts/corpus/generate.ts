/**
 * Generates the synthetic fidelity corpus: `node scripts/corpus/generate.ts [outDir] [count] [seed]`.
 *
 * Apps are assembled the way code generators assemble them: a framework
 * scaffold (create-vite / create-next-app shapes), 2–4 features with common
 * dependencies, optional Tailwind, and in about a third of apps one seeded
 * fault with a known expected outcome. meta.json records all of it, so the
 * study can split agreement by framework, feature, dependency and fault.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FEATURES, type Target } from './features.ts';

export type Fault = 'none' | 'logic' | 'crash' | 'undeclared-import' | 'bad-version' | 'syntax' | 'type-error';

export interface AppMeta {
  id: string;
  target: Target;
  framework: 'vite-react' | 'nextjs' | 'vite-vanilla';
  features: string[];
  tailwind: boolean;
  react: string | null;
  fault: Fault;
  /** Feature that carries a logic bug, if fault is "logic". */
  buggyFeature: string | null;
  /** Ground truth: should a correct environment pass this app's checks? */
  expected: 'pass' | 'fail';
}

const TITLES = ['Habit', 'Budget', 'Recipe', 'Workout', 'Reading', 'Travel', 'Garden', 'Pantry', 'Study', 'Movie', 'Chore', 'Music'];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateApp(index: number, seed: number): { meta: AppMeta; files: Record<string, string> } {
  const r = rng(seed * 1000 + index);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const target: Target = index % 3 === 0 ? 'vite-react' : index % 3 === 1 ? (r() < 0.67 ? 'next-app' : 'next-pages') : 'vite-vanilla';
  const react = target === 'vite-vanilla' ? null : target === 'vite-react' && r() < 0.3 ? '18.3.1' : '19.1.0';
  const tailwind = target === 'vite-vanilla' ? false : r() < (target === 'vite-react' ? 0.35 : 0.6);

  const eligible = Object.entries(FEATURES)
    .filter(([, f]) => (target === 'vite-vanilla' ? !!f.vanilla : !!f.react))
    .filter(([, f]) => !f.targets || f.targets.includes(target))
    .filter(([id]) => id !== 'tailwind-modal' || tailwind)
    .map(([id]) => id);
  const count = 2 + Math.floor(r() * 3);
  const features: string[] = [];
  while (features.length < Math.min(count, eligible.length)) {
    const f = pick(eligible);
    if (!features.includes(f)) features.push(f);
  }
  if (tailwind && eligible.includes('tailwind-modal') && !features.includes('tailwind-modal') && r() < 0.5) features.push('tailwind-modal');

  const roll = r();
  const fault: Fault =
    roll < 0.65 ? 'none' : roll < 0.78 ? 'logic' : roll < 0.83 ? 'crash' : roll < 0.87 ? 'undeclared-import' : roll < 0.91 ? 'bad-version' : roll < 0.95 ? 'syntax' : 'type-error';
  const buggyFeature = fault === 'logic' ? pick(features) : null;
  const expected = fault === 'none' || fault === 'type-error' ? 'pass' : 'fail';

  const title = `${pick(TITLES)} Tracker`;
  const id = `${String(index).padStart(3, '0')}-${target}`;
  const meta: AppMeta = {
    id,
    target,
    framework: target === 'vite-react' ? 'vite-react' : target === 'vite-vanilla' ? 'vite-vanilla' : 'nextjs',
    features,
    tailwind,
    react,
    fault,
    buggyFeature,
    expected,
  };
  const files = target === 'vite-vanilla' ? vanillaApp(meta, title) : reactApp(meta, title);
  files['checks.spec.ts'] = checksFile(meta, title);
  files['meta.json'] = JSON.stringify(meta, null, 2) + '\n';
  return { meta, files };
}

function componentName(feature: string): string {
  return feature.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('') + 'Feature';
}

function fetchSource(target: Target): string {
  return target === 'vite-react' ? '/data/products.json' : '/api/products';
}

function reactApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const deps: Record<string, string> = { react: meta.react!, 'react-dom': meta.react! };
  for (const f of meta.features) Object.assign(deps, FEATURES[f].deps);
  const next = meta.target !== 'vite-react';
  if (next) deps.next = '15.5.4';
  if (meta.fault === 'bad-version') deps['react-confetti'] = '^99.0.0';

  const componentDir = meta.target === 'vite-react' ? 'src/components' : meta.target === 'next-app' ? 'app/components' : 'components';
  for (const f of meta.features) {
    let code = FEATURES[f].react!(meta.buggyFeature === f);
    if (next && meta.target === 'next-app') code = `'use client';\n\n${code}`;
    files[`${componentDir}/${componentName(f)}.tsx`] = code;
    Object.assign(files, FEATURES[f].files?.(meta.target));
  }
  const faulted = meta.features[0];
  const faultFile = `${componentDir}/${componentName(faulted)}.tsx`;
  if (meta.fault === 'syntax') files[faultFile] = files[faultFile].replace(/\nexport default function/, '\nconst broken = ;\n\nexport default function');
  if (meta.fault === 'type-error') files[faultFile] = files[faultFile].replace(/\nexport default function/, "\nconst budget: number = 'unlimited';\nvoid budget;\n\nexport default function");
  if (meta.fault === 'undeclared-import') {
    files[faultFile] = files[faultFile].replace(/(\n\nexport default function)/, `\nimport { nanoid } from 'nanoid';\nconst sessionId = nanoid(8);\nvoid sessionId;$1`);
    if (!files[faultFile].includes('nanoid')) files[faultFile] = `import { nanoid } from 'nanoid';\nvoid nanoid(8);\n` + files[faultFile];
  }

  const imports = meta.features.map((f) => `import ${componentName(f)} from '${meta.target === 'vite-react' ? './components' : meta.target === 'next-app' ? './components' : '../components'}/${componentName(f)}';`).join('\n');
  const body = meta.features.map((f) => `        <${componentName(f)}${f === 'fetch' ? ` source="${fetchSource(meta.target)}"` : ''} />`).join('\n');
  const crash = meta.fault === 'crash' ? `  const settings = (globalThis as any).__APP_SETTINGS__;\n  const theme = settings.theme;\n` : '';
  const main = `<main${meta.tailwind ? ' className="mx-auto max-w-2xl p-6 space-y-6"' : ''}${meta.fault === 'crash' ? ' data-theme={theme}' : ''}>
        <h1${meta.tailwind ? ' className="text-2xl font-bold"' : ''}>${title}</h1>
${body}
      </main>`;
  const tailwindCss = `@import "tailwindcss";\n\n`;
  const baseCss = `body {\n  font-family: system-ui, sans-serif;\n  margin: 0;\n}\n\nmain {\n  max-width: 40rem;\n  margin: 2rem auto;\n  padding: 0 1rem;\n}\n\nsection {\n  margin-bottom: 1.5rem;\n}\n`;

  const devDeps: Record<string, string> = { typescript: '^5.7.2', '@types/react': meta.react!.startsWith('19') ? '^19.0.0' : '^18.3.12', '@types/react-dom': meta.react!.startsWith('19') ? '^19.0.0' : '^18.3.1' };
  if (meta.target === 'vite-react') {
    Object.assign(devDeps, { vite: '^6.0.5', '@vitejs/plugin-react': '^4.3.4' });
    if (meta.tailwind) Object.assign(devDeps, { tailwindcss: '^4.0.0', '@tailwindcss/vite': '^4.0.0' });
    files['package.json'] = pkg(meta.id, { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' }, deps, devDeps, true);
    files['index.html'] = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${title}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`;
    files['vite.config.ts'] = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n${meta.tailwind ? "import tailwindcss from '@tailwindcss/vite';\n" : ''}\nexport default defineConfig({\n  plugins: [react()${meta.tailwind ? ', tailwindcss()' : ''}],\n});\n`;
    files['src/main.tsx'] = `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`;
    files['src/App.tsx'] = `${imports}\n\nexport default function App() {\n${crash}  return (\n    ${main}\n  );\n}\n`;
    files['src/index.css'] = (meta.tailwind ? tailwindCss : '') + baseCss;
    files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true }, include: ['src'] }, null, 2) + '\n';
  } else {
    Object.assign(devDeps, { '@types/node': '^20' });
    if (meta.tailwind) Object.assign(devDeps, { tailwindcss: '^4.0.0', '@tailwindcss/postcss': '^4.0.0' });
    files['package.json'] = pkg(meta.id, { dev: 'next dev', build: 'next build', start: 'next start' }, deps, devDeps, false);
    files['next.config.ts'] = `import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`;
    files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true, isolatedModules: true, jsx: 'preserve', incremental: true, plugins: [{ name: 'next' }], paths: { '@/*': ['./*'] } }, include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'], exclude: ['node_modules'] }, null, 2) + '\n';
    if (meta.tailwind) files['postcss.config.mjs'] = `const config = {\n  plugins: ['@tailwindcss/postcss'],\n};\n\nexport default config;\n`;
    const css = (meta.tailwind ? tailwindCss : '') + baseCss;
    if (meta.target === 'next-app') {
      files['app/globals.css'] = css;
      files['app/layout.tsx'] = `import type { Metadata } from 'next';\nimport './globals.css';\n\nexport const metadata: Metadata = {\n  title: '${title}',\n};\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return (\n    <html lang="en">\n      <body${meta.tailwind ? ' className="antialiased bg-gray-50"' : ''}>{children}</body>\n    </html>\n  );\n}\n`;
      const clientCrash = meta.fault === 'crash';
      files['app/page.tsx'] = `${clientCrash ? "'use client';\n\n" : ''}${imports}\n\nexport default function Home() {\n${crash}  return (\n    ${main}\n  );\n}\n`;
    } else {
      files['styles/globals.css'] = css;
      files['pages/_app.tsx'] = `import type { AppProps } from 'next/app';\nimport Head from 'next/head';\nimport '../styles/globals.css';\n\nexport default function App({ Component, pageProps }: AppProps) {\n  return (\n    <>\n      <Head>\n        <title>${title}</title>\n      </Head>\n      <Component {...pageProps} />\n    </>\n  );\n}\n`;
      files['pages/index.tsx'] = `${imports}\n\nexport default function Home() {\n${crash}  return (\n    ${main}\n  );\n}\n`;
    }
  }
  return files;
}

function vanillaApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const deps: Record<string, string> = {};
  if (meta.fault === 'bad-version') deps['canvas-confetti'] = '^99.0.0';
  files['package.json'] = pkg(meta.id, { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview' }, deps, { typescript: '^5.7.2', vite: '^6.0.5' }, true);
  files['index.html'] = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${title}</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n`;
  for (const f of meta.features) {
    files[`src/features/${f}.ts`] = FEATURES[f].vanilla!(meta.buggyFeature === f);
    Object.assign(files, FEATURES[f].files?.(meta.target));
  }
  const faultFile = `src/features/${meta.features[0]}.ts`;
  if (meta.fault === 'syntax') files[faultFile] = files[faultFile].replace('export function mount', 'const broken = ;\nexport function mount');
  if (meta.fault === 'type-error') files[faultFile] = files[faultFile].replace('export function mount', "const budget: number = 'unlimited';\nvoid budget;\nexport function mount");
  if (meta.fault === 'undeclared-import') files[faultFile] = `import { nanoid } from 'nanoid';\nconst sessionId = nanoid(8);\nvoid sessionId;\n` + files[faultFile];
  const imports = meta.features.map((f, i) => `import { mount as mount${i} } from './features/${f}';`).join('\n');
  const mounts = meta.features.map((_, i) => `mount${i}(main);`).join('\n');
  const crash = meta.fault === 'crash' ? `const settings = (globalThis as any).__APP_SETTINGS__;\ndocument.body.dataset.theme = settings.theme;\n` : '';
  files['src/main.ts'] = `import './style.css';\n${imports}\n\n${crash}const main = document.createElement('main');\nmain.append(Object.assign(document.createElement('h1'), { textContent: '${title}' }));\n${mounts}\ndocument.querySelector('#app')!.append(main);\n`;
  files['src/style.css'] = `body {\n  font-family: system-ui, sans-serif;\n  margin: 0;\n}\n\nmain {\n  max-width: 40rem;\n  margin: 2rem auto;\n  padding: 0 1rem;\n}\n`;
  files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src'] }, null, 2) + '\n';
  return files;
}

function pkg(name: string, scripts: Record<string, string>, deps: Record<string, string>, devDeps: Record<string, string>, module: boolean): string {
  return (
    JSON.stringify(
      { name: `corpus-${name}`, private: true, version: '0.0.0', ...(module ? { type: 'module' } : {}), scripts, dependencies: sortKeys(deps), devDependencies: sortKeys(devDeps) },
      null,
      2,
    ) + '\n'
  );
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function checksFile(meta: AppMeta, title: string): string {
  const checks = [
    `  'renders the app title': async ({ app, expect }) => {\n    await expect(app.getByRole('heading', { level: 1 })).toHaveText('${title}');\n  },`,
    ...meta.features.map((f) => `  '${f}': async ({ app, expect }) => {\n    ${FEATURES[f].check}\n  },`),
  ];
  return `// Generated by scripts/corpus/generate.ts. Default export: check name → check function.\nexport default {\n${checks.join('\n')}\n};\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? 'corpus';
  const count = Number(process.argv[3] ?? 100);
  const seed = Number(process.argv[4] ?? 1);
  await rm(out, { recursive: true, force: true });
  const metas: AppMeta[] = [];
  for (let i = 0; i < count; i++) {
    const { meta, files } = generateApp(i, seed);
    metas.push(meta);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(out, meta.id, path)), { recursive: true });
      await writeFile(join(out, meta.id, path), content);
    }
  }
  await writeFile(join(out, '_corpus.json'), JSON.stringify({ seed, count, apps: metas }, null, 2) + '\n');
  const by = (k: (m: AppMeta) => string) => metas.reduce<Record<string, number>>((a, m) => ((a[k(m)] = (a[k(m)] ?? 0) + 1), a), {});
  console.log('frameworks', by((m) => m.target), '\nfaults', by((m) => m.fault), '\nexpected', by((m) => m.expected));
}
