/**
 * Sandburg's own lint rules (an oxlint JavaScript plugin, loaded by .oxlintrc.json): invariants of
 * the security model (ADR 0001, 0005) that a reviewer would otherwise have to remember.
 *
 * - `sandburg/cache-key-digest`: a cache on the host is keyed by digests, not by names an app
 *   controls. A file path under a cache directory, or the key of a long-lived cache map, built from
 *   a package name, a project-relative path, a request's path or the like must also include a
 *   digest. Two sandboxes that name a file alike must not share an entry (one would read what the
 *   other wrote); keyed by the content's digest, they can.
 * - `sandburg/one-host-server`: the host listens with one HTTP server (host-server.ts), whose handler
 *   finds the sandbox by its Host and refuses requests from another site, and whose upgrade handler
 *   checks the file channel's origin. A server made elsewhere would serve without those checks.
 *   The reviewed exceptions (the egress proxy, a port probe) turn the rule off in .oxlintrc.json.
 * - `sandburg/no-write-in-place`: an install's files may be hard links into the package store
 *   (package-store.ts), shared by every install of that package: a write into one would change all
 *   of them, and the store. Code that writes into installs writes new files: under a temporary
 *   name, after removing the path in the same block, or with an exclusive flag (`wx`).
 *
 * The rules see one file at a time and follow a path through the `const`s it was built from; a
 * path that arrives as a parameter is checked where it is built. Names are the contract: a key's
 * name says what it is (a digest's name says digest, hash or sha).
 */

type Node = { type: string; range: [number, number]; parent?: Node; [k: string]: unknown };
interface Variable {
  defs: { type: string; node: Node; name: Node }[];
  references: { isWrite(): boolean; init?: boolean }[];
}
interface Scope {
  set: Map<string, Variable>;
  upper: Scope | null;
  type: string;
}
interface Context {
  filename: string;
  sourceCode: { getScope(node: Node): Scope; getText(node: Node): string };
  report(d: { node: Node; message: string }): void;
}
interface Rule {
  meta: { type: 'problem'; docs: { description: string } };
  create(context: Context): Record<string, (node: never) => void>;
}

const FS_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises']);

/** fs functions that create or change a path, and which argument is that path. */
const FS_WRITES: Record<string, number> = {
  writeFile: 0,
  writeFileSync: 0,
  appendFile: 0,
  appendFileSync: 0,
  createWriteStream: 0,
  mkdir: 0,
  mkdirSync: 0,
  rename: 1,
  renameSync: 1,
  copyFile: 1,
  copyFileSync: 1,
  cp: 1,
  cpSync: 1,
  link: 1,
  linkSync: 1,
  symlink: 1,
  symlinkSync: 1,
  open: 0,
  openSync: 0,
  truncate: 0,
  truncateSync: 0,
  chmod: 0,
  chmodSync: 0,
};

/** Writes that change a file's bytes or mode in place (no-write-in-place). */
const IN_PLACE = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'open', 'openSync', 'truncate', 'truncateSync', 'chmod', 'chmodSync']);
const REMOVES = new Set(['rm', 'rmSync', 'unlink', 'unlinkSync']);

/** A path component named for a cache directory. */
const CACHE_ROOT = /cache|store|bundles|installs|seeds|\.sandburg/i;
/** A name an app (or a request from its page) controls: a package's, a file's in the project, a URL's. */
const APP_NAME =
  /^(name|names|rel|relPath|relative|location|specifier|spec|request|req|pkg|pkgName|packageName|project|projectDir|pathname|url|href|importer|query|headers|path)$/i;
/** A digest: what a cache may be keyed by. */
const DIGEST = /digest|hash|sha(1|256|512)?$|integrity|checksum|fingerprint/i;

/** What an expression is built from: the names of its non-literal parts. */
function parts(context: Context, node: Node | undefined, seen = new Set<Node>()): string[] {
  if (!node || seen.has(node)) return [];
  seen.add(node);
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' && CACHE_ROOT.test(node.value) ? ['.sandburg'] : [];
    case 'TemplateLiteral':
      return [
        ...(node.quasis as Node[]).flatMap((q) => (CACHE_ROOT.test((q.value as { raw: string }).raw) ? ['.sandburg'] : [])),
        ...(node.expressions as Node[]).flatMap((e) => parts(context, e, seen)),
      ];
    case 'BinaryExpression':
    case 'LogicalExpression':
      return [...parts(context, node.left as Node, seen), ...parts(context, node.right as Node, seen)];
    case 'ConditionalExpression':
      return [...parts(context, node.consequent as Node, seen), ...parts(context, node.alternate as Node, seen)];
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
    case 'AwaitExpression':
      return parts(context, (node.expression ?? node.argument) as Node, seen);
    case 'Identifier': {
      // The name says what it is (a tmp, a key), and so does what it was made from.
      const init = constInit(context, node);
      return [node.name as string, ...(init ? parts(context, init, seen) : [])];
    }
    case 'MemberExpression':
      // `x.slice(…)`, `x.toString()` and the like are x; `a.b.name` is `name`.
      return [node.computed ? '?' : ((node.property as Node).name as string)];
    case 'CallExpression': {
      const callee = node.callee as Node;
      const name = calleeName(callee);
      // Path builders and string methods are what they are given.
      if (name && /^(join|resolve|dirname|basename|normalize|relative|format)$/.test(name)) {
        return (node.arguments as Node[]).flatMap((a) => parts(context, a, seen));
      }
      if (callee.type === 'MemberExpression' && name && /^(slice|substring|toString|toLowerCase|replace|replaceAll|padStart|trim)$/.test(name)) {
        return [...parts(context, callee.object as Node, seen), ...(node.arguments as Node[]).flatMap((a) => parts(context, a, seen))];
      }
      // createHash(…).update(…).digest(…) and the like.
      if (callee.type === 'MemberExpression' && name === 'digest') return ['digest'];
      return [name ?? '?'];
    }
    default:
      return ['?'];
  }
}

function calleeName(callee: Node): string | undefined {
  if (callee.type === 'Identifier') return callee.name as string;
  if (callee.type === 'MemberExpression' && !callee.computed) return (callee.property as Node).name as string;
  return undefined;
}

function variableOf(context: Context, id: Node): Variable | undefined {
  for (let scope: Scope | null = context.sourceCode.getScope(id); scope; scope = scope.upper) {
    const v = scope.set.get(id.name as string);
    if (v) return v;
  }
  return undefined;
}

/** The initializer of a variable that is never assigned after it, or undefined. */
function constInit(context: Context, id: Node): Node | undefined {
  const v = variableOf(context, id);
  const def = v?.defs[0];
  if (!v || v.defs.length !== 1 || def?.type !== 'Variable') return undefined;
  const declarator = def.node;
  if ((declarator.id as Node).type !== 'Identifier' || !declarator.init) return undefined;
  if (v.references.some((r) => r.isWrite() && !r.init)) return undefined;
  return declarator.init as Node;
}

/** The fs function a call calls (`writeFile(…)`, `fs.writeFile(…)`, `fsp.writeFile(…)`), by the module's imports. */
function fsCalls(): { imports: (node: Node) => void; fsName: (call: Node) => string | undefined } {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  return {
    imports(node) {
      if (!FS_MODULES.has((node.source as Node).value as string)) return;
      for (const s of node.specifiers as Node[]) {
        const local = (s.local as Node).name as string;
        if (s.type === 'ImportSpecifier') named.set(local, ((s.imported as Node).name ?? (s.imported as Node).value) as string);
        else namespaces.add(local);
      }
    },
    fsName(call) {
      const callee = call.callee as Node;
      if (callee.type === 'Identifier') return named.get(callee.name as string);
      if (callee.type === 'MemberExpression' && !callee.computed && (callee.object as Node).type === 'Identifier' && namespaces.has((callee.object as Node).name as string)) {
        return (callee.property as Node).name as string;
      }
      return undefined;
    },
  };
}

const describe = (names: string[]) => [...new Set(names.filter((n) => APP_NAME.test(n)))].map((n) => `\`${n}\``).join(', ');

const cacheKeyDigest: Rule = {
  meta: { type: 'problem', docs: { description: 'A cache on the host is keyed by digests, not by names an app controls.' } },
  create(context) {
    const fs = fsCalls();
    const check = (node: Node, built: string[], what: string) => {
      if (!built.some((n) => APP_NAME.test(n)) || built.some((n) => DIGEST.test(n))) return;
      context.report({
        node,
        message: `${what} is built from ${describe(built)}, which an app controls, and no digest: two sandboxes that name a file alike would share the entry. Key it by a digest (createHash, a name with digest/hash/sha in it), as the host's caches are.`,
      });
    };
    return {
      ImportDeclaration: (node: Node) => fs.imports(node),
      CallExpression(node: Node) {
        const name = fs.fsName(node);
        if (name !== undefined && name in FS_WRITES) {
          const built = parts(context, (node.arguments as Node[])[FS_WRITES[name]]);
          if (built.some((n) => CACHE_ROOT.test(n))) check(node, built, 'This path under a cache directory');
          return;
        }
        // A long-lived map named as a cache (module scope or a class's field): `xCache.set(key, …)`.
        const callee = node.callee as Node;
        if (callee.type !== 'MemberExpression' || callee.computed || (callee.property as Node).name !== 'set' || (node.arguments as Node[]).length !== 2) return;
        const target = callee.object as Node;
        const mapName = target.type === 'Identifier' ? (target.name as string) : target.type === 'MemberExpression' && (target.object as Node).type === 'ThisExpression' ? ((target.property as Node).name as string) : undefined;
        if (!mapName || !/cache/i.test(mapName)) return;
        if (target.type === 'Identifier' && !['module', 'global'].includes(scopeOf(context, target)?.type ?? '')) return;
        check(node, parts(context, (node.arguments as Node[])[0]), `The key of ${mapName}`);
      },
    };
  },
};

function scopeOf(context: Context, id: Node): Scope | undefined {
  for (let scope: Scope | null = context.sourceCode.getScope(id); scope; scope = scope.upper) if (scope.set.has(id.name as string)) return scope;
  return undefined;
}

const SERVER_MODULES = new Set(['http', 'https', 'http2', 'net', 'tls', 'node:http', 'node:https', 'node:http2', 'node:net', 'node:tls']);
const SERVER_FACTORIES = new Set(['createServer', 'createSecureServer', 'Server']);

const oneHostServer: Rule = {
  meta: { type: 'problem', docs: { description: 'The host listens with one server, whose handler checks the sandbox and the site of each request.' } },
  create(context) {
    const named = new Map<string, string>();
    const namespaces = new Set<string>();
    const report = (node: Node, what: string) =>
      context.report({
        node,
        message: `${what}: the host listens with one server (orchestrator/host-server.ts), whose handler checks each request's sandbox and site and the file channel's origin; a server made here would skip those checks. Serve a route through the adapter's serve() instead, or add the file to the reviewed list in .oxlintrc.json.`,
      });
    return {
      ImportDeclaration(node: Node) {
        if (!SERVER_MODULES.has((node.source as Node).value as string)) return;
        for (const s of node.specifiers as Node[]) {
          const local = (s.local as Node).name as string;
          if (s.type !== 'ImportSpecifier') namespaces.add(local);
          else if (SERVER_FACTORIES.has(((s.imported as Node).name ?? (s.imported as Node).value) as string)) named.set(local, (s.imported as Node).name as string);
        }
      },
      'CallExpression, NewExpression'(node: Node) {
        const callee = node.callee as Node;
        if (callee.type === 'Identifier' && named.has(callee.name as string)) return report(node, `${named.get(callee.name as string)}()`);
        if (callee.type === 'MemberExpression' && !callee.computed && (callee.object as Node).type === 'Identifier' && namespaces.has((callee.object as Node).name as string)) {
          const prop = (callee.property as Node).name as string;
          if (SERVER_FACTORIES.has(prop)) report(node, `${(callee.object as Node).name as string}.${prop}()`);
        }
        if (node.type === 'NewExpression' && callee.type === 'Identifier' && /^WebSocketServer$|^WebSocket\.Server$/.test(callee.name as string)) report(node, 'new WebSocketServer()');
      },
    };
  },
};

/** The statements before `node`'s in the block that holds it. */
function earlierStatements(node: Node): Node[] {
  let child = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (p.type === 'BlockStatement' || p.type === 'Program' || p.type === 'StaticBlock') {
      const body = p.body as Node[];
      return body.slice(0, body.indexOf(child));
    }
    if (/Function/.test(p.type)) return [];
  }
  return [];
}

/** The calls a statement makes itself: not in a function, nor in a block or branch it holds. */
function callsIn(statement: Node): Node[] {
  const out: Node[] = [];
  const visit = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const x = n as Node;
    if (typeof x.type !== 'string' || /Function/.test(x.type) || (x !== statement && /Statement$/.test(x.type))) return;
    if (x.type === 'CallExpression') out.push(x);
    for (const key in x) if (key !== 'parent' && key !== 'range' && key !== 'loc') visit(x[key]);
  };
  visit(statement);
  return out;
}

const noWriteInPlace: Rule = {
  meta: { type: 'problem', docs: { description: "Code that writes into installs writes new files: an install's files may be hard links into the package store." } },
  create(context) {
    const fs = fsCalls();
    return {
      ImportDeclaration: (node: Node) => fs.imports(node),
      CallExpression(node: Node) {
        const name = fs.fsName(node);
        if (!name || !IN_PLACE.has(name)) return;
        const args = node.arguments as Node[];
        const path = args[0];
        if (!path) return;
        // An exclusive flag fails on a path that exists; a read-only open changes nothing.
        const options = name.startsWith('open') ? args[1] : args[name.startsWith('chmod') || name.startsWith('truncate') ? 99 : name === 'createWriteStream' ? 1 : 2];
        const flag = options?.type === 'Literal' ? options.value : options?.type === 'ObjectExpression' ? ((options.properties as Node[]).find((p) => ((p.key as Node | undefined)?.name ?? (p.key as Node | undefined)?.value) === 'flags' || ((p.key as Node | undefined)?.name ?? (p.key as Node | undefined)?.value) === 'flag')?.value as Node | undefined)?.value : undefined;
        if (typeof flag === 'string' && (flag.includes('x') || (name.startsWith('open') && /^r$/.test(flag)))) return;
        if (name.startsWith('open') && args.length < 2) return;
        // A temporary name, made for this write.
        if (parts(context, path).some((n) => /tmp|temp/i.test(n)) || /tmp|temp/i.test(context.sourceCode.getText(path))) return;
        // Removed first, in the same block.
        const text = context.sourceCode.getText(path);
        const removed = earlierStatements(node).some((st) =>
          callsIn(st).some((c) => {
            const n = fs.fsName(c);
            return !!n && REMOVES.has(n) && (c.arguments as Node[])[0] && context.sourceCode.getText((c.arguments as Node[])[0]) === text;
          }),
        );
        if (removed) return;
        context.report({
          node,
          message: `${name}(${text}) may change a file in place: an install's files may be hard links into the package store, shared by every install of the package. Remove the path first (see replaceFile), write under a temporary name and rename, or pass flag 'wx'.`,
        });
      },
    };
  },
};

export default {
  meta: { name: 'sandburg' },
  rules: { 'cache-key-digest': cacheKeyDigest, 'one-host-server': oneHostServer, 'no-write-in-place': noWriteInPlace },
};
