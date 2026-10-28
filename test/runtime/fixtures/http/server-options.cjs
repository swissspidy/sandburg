// Server timeout options: defaults, what an option sets, what is refused, and setTimeout's.
const http = require('http');
const props = (s) => ['timeout', 'requestTimeout', 'headersTimeout', 'keepAliveTimeout', 'keepAliveTimeoutBuffer', 'connectionsCheckingInterval'].map((k) => `${k}=${s[k]}`).join(' ');
const out = [];
out.push('default: ' + props(http.createServer()));
out.push('requestTimeout 1000: ' + props(http.createServer({ requestTimeout: 1000 })));
out.push('all: ' + props(new http.Server({ requestTimeout: 0, headersTimeout: 7000, keepAliveTimeout: 100, keepAliveTimeoutBuffer: 5, connectionsCheckingInterval: 10 }, () => {})));
for (const o of [{ headersTimeout: 2000, requestTimeout: 1000 }, { requestTimeout: -1 }, { keepAliveTimeout: 1.5 }, { headersTimeout: '5' }]) {
  try {
    http.createServer(o);
    out.push(JSON.stringify(o) + ': ok');
  } catch (e) {
    out.push(JSON.stringify(o) + `: ${e.name} ${e.code} ${e.message}`);
  }
}
const s = http.createServer();
const cb = () => {};
out.push(`setTimeout returns the server: ${s.setTimeout(5, cb) === s} timeout=${s.timeout} listeners=${s.listenerCount('timeout')}`);
console.log(out.join('\n'));
