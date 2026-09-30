/**
 * Minimal stand-ins for Next.js server modules that almostnode does not
 * provide. App Router route handlers run inside the browser via almostnode's
 * CommonJS loader and commonly import NextResponse from "next/server".
 * Results record which shims were used (InstallReport.shims), because a shim
 * is a fidelity risk.
 */
export const NEXT_SERVER_SHIM = `'use strict';
class NextResponse extends Response {
  static json(body, init) {
    const headers = new Headers(init && init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new NextResponse(JSON.stringify(body), Object.assign({}, init, { headers }));
  }
  static redirect(url, init) {
    const status = typeof init === 'number' ? init : (init && init.status) || 307;
    return new NextResponse(null, { status, headers: { location: String(url) } });
  }
  static next(init) {
    return new NextResponse(null, init);
  }
  static rewrite(_url, init) {
    return new NextResponse(null, init);
  }
}
class NextRequest extends Request {
  get nextUrl() {
    return new URL(this.url);
  }
}
function after(fn) {
  return Promise.resolve().then(typeof fn === 'function' ? fn : () => fn);
}
module.exports = { NextResponse, NextRequest, after, userAgent: () => ({ ua: '' }) };
`;

/** Files written into the virtual FS: path → contents. */
export const NEXT_SHIM_FILES: Record<string, string> = {
  '/node_modules/next/package.json': JSON.stringify({ name: 'next', version: '0.0.0-sandburg-shim', main: 'server.js' }),
  '/node_modules/next/server.js': NEXT_SERVER_SHIM,
};
