/**
 * Dependency resolution for the almostnode adapter: direct dependencies →
 * esm.sh import map. Pure functions, shared by the browser adapter and tests.
 */

const ESM_CDN = 'https://esm.sh';
/** Shared once in the import map so every package sees one instance. */
const SINGLETONS = ['react', 'react-dom'];

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
    imports[name] = `${ESM_CDN}/${spec}${ext.length ? `?external=${ext.join(',')}` : ''}`;
    imports[`${name}/`] = `${ESM_CDN}/${spec}${ext.length ? `&external=${ext.join(',')}` : ''}/`;
  }
  return { imports };
}

export function injectImportMap(html: string, map: ImportMap): string {
  const tag = `<script type="importmap">${JSON.stringify(map, null, 2)}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  return tag + '\n' + html;
}
