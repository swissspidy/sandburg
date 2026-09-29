import { EgressProxy } from './src/orchestrator/egress-proxy.ts';
import { originMatcher, newEgressStats } from './src/orchestrator/egress.ts';
const stats = newEgressStats();
const p = new EgressProxy(originMatcher(['https://playground.wordpress.net']), stats);
await p.listen();
console.log(p.port);
process.stdin.resume();
process.on('SIGTERM', () => { console.error(JSON.stringify(stats)); process.exit(0); });
