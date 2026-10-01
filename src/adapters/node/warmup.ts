/**
 * Warm-up projects: small apps on the stacks generated apps use most (Vite, Vite + React, Next.js),
 * which a session runs before a batch when their installs are missing (Session.prewarm). The first
 * app of a stack then starts from their install (npm installs only the difference), their shared
 * transforms and preloads, and, for Next.js, the webpack seed of their versions, instead of paying
 * for all of it, often in several tabs at once.
 */
import { projectFromFiles } from '../../project.ts';
import type { Project } from '../../types.ts';

const pkg = (name: string, deps: Record<string, string>, devDeps: Record<string, string>, dev = 'vite') =>
  JSON.stringify({ name, private: true, type: 'module', scripts: { dev }, dependencies: deps, devDependencies: devDeps }, null, 2);

const REACT = { react: '^19.1.0', 'react-dom': '^19.1.0' };
const VITE = { typescript: '^5.7.2', vite: '^6.0.5' };

export function warmups(): Project[] {
  return [
    projectFromFiles(
      {
        'package.json': pkg('sandburg-warmup-vite', {}, VITE),
        'index.html': '<!doctype html>\n<html><head><meta charset="utf-8"><title>Warm-up</title></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>\n',
        'src/main.ts': `document.querySelector<HTMLDivElement>('#app')!.innerHTML = '<h1>Vite</h1>';\n`,
      },
      { name: 'sandburg-warmup-vite', path: 'sandburg:warmup/vite' },
    ),
    projectFromFiles(
      {
        'package.json': pkg('sandburg-warmup-vite-react', REACT, { ...VITE, '@vitejs/plugin-react': '^4.3.4', '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0' }),
        'vite.config.ts': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n`,
        'index.html': '<!doctype html>\n<html><head><meta charset="utf-8"><title>Warm-up</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
        'src/main.tsx': `import { StrictMode, useState } from 'react';\nimport { createRoot } from 'react-dom/client';\n\nfunction App() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>Count {n}</button>;\n}\n\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);\n`,
      },
      { name: 'sandburg-warmup-vite-react', path: 'sandburg:warmup/vite-react' },
    ),
    projectFromFiles(
      {
        'package.json': pkg('sandburg-warmup-next', { next: '^15', ...REACT }, { typescript: '^5.7.2', '@types/react': '^19.0.0', '@types/node': '^22' }, 'next dev'),
        'app/layout.tsx': `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (<html lang="en"><body>{children}</body></html>);\n}\n`,
        'app/page.tsx': `export default function Page() {\n  return <h1>Next.js</h1>;\n}\n`,
      },
      { name: 'sandburg-warmup-next', path: 'sandburg:warmup/next' },
    ),
  ];
}
