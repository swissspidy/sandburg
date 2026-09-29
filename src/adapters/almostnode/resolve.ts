/**
 * Dependency resolution for the almostnode adapter: direct dependencies →
 * esm.sh import map. Pure functions, shared by the browser adapter and tests.
 */

const ESM_CDN = 'https://esm.sh';
/** Shared once in the import map so every package sees one instance. */
const SINGLETONS = ['react', 'react-dom'];
const EXACT_SUBPATHS: Record<string, string[]> = {
  react: ['jsx-runtime', 'jsx-dev-runtime'],
  'react-dom': ['client', 'server'],
};

export type ImportMap = { imports: Record<string, string> };

/** Exact versions of installed packages from package-lock.json v2/v3, or null for v1. */
export function lockfileVersions(lockJson: string): Record<string, string> | null {
  const lock = JSON.parse(lockJson) as { packages?: Record<string, { version?: string }> };
  if (!lock.packages) return null;
  const versions: Record<string, string> = {};
  for (const [key, entry] of Object.entries(lock.packages)) {
    const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
    if (m && entry.version) versions[m[1]] = entry.version;
  }
  return versions;
}

export function buildImportMap(deps: Record<string, string>): ImportMap {
  const imports: Record<string, string> = {};
  const externals = SINGLETONS.filter((name) => name in deps);
  for (const [name, version] of Object.entries(deps)) {
    const spec = `${name}@${encodeURIComponent(version)}`;
    // react has no externals; react-dom shares react; everything else shares both.
    const ext = name === 'react' ? [] : name === 'react-dom' ? externals.filter((e) => e === 'react') : externals;
    // Development builds, as `vite` and `next dev` serve them (better errors, same warnings).
    const query = ['dev', ...(ext.length ? [`external=${ext.join(',')}`] : [])];
    imports[name] = `${ESM_CDN}/${spec}?${query.join('&')}`;
    imports[`${name}/`] = `${ESM_CDN}/${spec}&${query.join('&')}/`;
    // Exact keys beat prefix keys, so pin the subpaths other import maps (almostnode's Next.js HTML) name explicitly.
    for (const sub of EXACT_SUBPATHS[name] ?? []) {
      imports[`${name}/${sub}`] = `${ESM_CDN}/${spec}/${sub}?${query.join('&')}`;
    }
  }
  return { imports };
}

/**
 * almostnode renders a Next.js App Router tree, root layout included, inside
 * div#__next. The layout's <html>/<head>/<body> then nest inside the page's own
 * body: React 18 tolerates that, but React 19 treats them as singletons bound
 * to the real document elements, and its event dispatch loops forever walking
 * from the target up to a container that is inside them. This JSX runtime
 * wrapper turns those three elements into components that apply their
 * attributes (lang, className, ...) to the real elements and render only their
 * children, which is what the browser's document looks like under `next dev`.
 */
export function documentElementsRuntime(runtimeUrl: string): string {
  const code = `export * from ${JSON.stringify(runtimeUrl)};
import * as rt from ${JSON.stringify(runtimeUrl)};
import { useLayoutEffect } from 'react';
const NAMES = { className: 'class', htmlFor: 'for' };
function apply(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || value == null || typeof value === 'object' || typeof value === 'function' || value === false) continue;
    const name = NAMES[key] ?? key;
    if (name === 'class') el.classList.add(...String(value).split(/\\s+/).filter(Boolean));
    else el.setAttribute(name, value === true ? '' : String(value));
  }
}
function Html(props) { useLayoutEffect(() => apply(document.documentElement, props)); return props.children ?? null; }
function Body(props) { useLayoutEffect(() => apply(document.body, props)); return props.children ?? null; }
function Head(props) { return props.children ?? null; }
const swap = (type) => (type === 'html' ? Html : type === 'body' ? Body : type === 'head' ? Head : type);
export const jsx = (type, ...rest) => rt.jsx(swap(type), ...rest);
export const jsxs = (type, ...rest) => rt.jsxs(swap(type), ...rest);
export const jsxDEV = (type, ...rest) => rt.jsxDEV(swap(type), ...rest);
`;
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
}

/** Next.js import map: the project's React, with document elements handled by the runtime wrapper. */
export function nextImportMap(deps: Record<string, string>): ImportMap {
  const map = buildImportMap(deps);
  for (const sub of ['jsx-runtime', 'jsx-dev-runtime']) {
    const key = `react/${sub}`;
    if (map.imports[key]) map.imports[key] = documentElementsRuntime(map.imports[key]);
  }
  return map;
}

export function injectImportMap(html: string, map: ImportMap): string {
  const tag = `<script type="importmap">${JSON.stringify(map, null, 2)}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  return tag + '\n' + html;
}

/**
 * almostnode's code transforms hard-code React 18.2.0 esm.sh URLs for react,
 * react/jsx-runtime, react-dom and react-dom/client, ahead of any import map.
 * Turning them back into bare specifiers lets the page's import map (with the
 * project's own React) decide. Longest URLs first so prefixes do not clobber.
 */
const ALMOSTNODE_REACT = 'https://esm.sh/react@18.2.0';
const ALMOSTNODE_REACT_DOM = 'https://esm.sh/react-dom@18.2.0';
const HARDCODED_REACT: [string, string][] = [
  [`${ALMOSTNODE_REACT}&dev/jsx-dev-runtime`, 'react/jsx-dev-runtime'],
  [`${ALMOSTNODE_REACT}&dev/jsx-runtime`, 'react/jsx-runtime'],
  [`${ALMOSTNODE_REACT_DOM}/client?dev`, 'react-dom/client'],
  [`${ALMOSTNODE_REACT_DOM}?dev`, 'react-dom'],
  [`${ALMOSTNODE_REACT}?dev`, 'react'],
];

export function unpinReact(code: string): string {
  if (!code.includes('esm.sh/react')) return code;
  for (const [url, bare] of HARDCODED_REACT) {
    code = code.replaceAll(`"${url}"`, `"${bare}"`).replaceAll(`'${url}'`, `'${bare}'`);
  }
  return code;
}
