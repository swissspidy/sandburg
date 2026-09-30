/**
 * Request and Response as in Node. A browser's Request drops "forbidden" headers (Cookie, Referer,
 * Origin, Host, …) and its Response drops Set-Cookie: they belong to the browser there. Node's
 * (undici's) keep them, and servers built on web Requests (h3, srvx, Hono, SolidStart, …) read
 * cookies and referers from them and set cookies on Responses. These subclasses keep the headers
 * they were given in an unfiltered Headers object (a Headers made on its own is not filtered).
 * Passed to fetch(), the browser still applies its own rules.
 */

type HeadersSource = HeadersInit | Headers | undefined;

const own = (init: HeadersSource, fallback?: Headers): Headers => {
  const h = new Headers();
  const from = init ?? fallback;
  if (!from) return h;
  if (from instanceof Headers) {
    from.forEach((v, k) => (k === 'set-cookie' ? undefined : h.append(k, v)));
    for (const c of from.getSetCookie?.() ?? []) h.append('set-cookie', c);
  } else if (Array.isArray(from)) for (const [k, v] of from) h.append(k, v);
  else for (const [k, v] of Object.entries(from)) h.append(k, v as string);
  return h;
};

const pin = (target: object, headers: Headers) => Object.defineProperty(target, 'headers', { value: headers, configurable: true });

export function installNodeFetchClasses(scope: Record<string, unknown>): void {
  const BaseRequest = scope.Request as typeof Request;
  const BaseResponse = scope.Response as typeof Response;
  if ((BaseRequest as unknown as { sandburg?: boolean }).sandburg) return;

  class NodeRequest extends BaseRequest {
    static sandburg = true;
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init);
      pin(this, own(init?.headers, input instanceof BaseRequest ? input.headers : undefined));
    }
    clone(): Request {
      const copy = super.clone();
      pin(copy, own(this.headers));
      Object.setPrototypeOf(copy, NodeRequest.prototype);
      return copy;
    }
  }

  class NodeResponse extends BaseResponse {
    static sandburg = true;
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
      pin(this, own(init?.headers));
    }
    clone(): Response {
      const copy = super.clone();
      pin(copy, own(this.headers));
      Object.setPrototypeOf(copy, NodeResponse.prototype);
      return copy;
    }
    static json(data: unknown, init?: ResponseInit): Response {
      const headers = own(init?.headers);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      return new NodeResponse(JSON.stringify(data), { ...init, headers });
    }
    static redirect(url: string | URL, status = 302): Response {
      return new NodeResponse(null, { status, headers: { location: new URL(url).href } });
    }
  }

  scope.Request = NodeRequest;
  scope.Response = NodeResponse;
}
