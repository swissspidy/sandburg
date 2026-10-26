import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_OPEN, INSTALL_KEY, RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

const install = {
  files: {
    'node_modules/bundled/package.json': JSON.stringify({ name: 'bundled', main: 'index.js' }),
    'node_modules/bundled/index.js': `module.exports = 'from the bundle';`,
    'node_modules/single/package.json': JSON.stringify({ name: 'single', main: 'index.js' }),
    'node_modules/single/index.js': `module.exports = 'asked for on its own';`,
  },
  bundled: ['node_modules/bundled/package.json', 'node_modules/bundled/index.js'],
};

// A program and its thread each load a package the preload bundle has and one it lacks; the
// second is required once the file channel is open (the harness holds it until the program asks).
const program = {
  'main.js': `
    ${CHANNEL_OPEN}
    const { Worker } = require('worker_threads');
    console.log('main:', require('bundled'));
    channelOpen().then(() => {
      console.log('main:', require('single'));
      const w = new Worker('/app/thread.js');
      w.on('message', (m) => console.log('thread:', m));
    });`,
  'thread.js': `
    const { parentPort } = require('worker_threads');
    parentPort.postMessage(require('bundled') + ', ' + require('single'));`,
};

/** Both runtimes have told the host what they read of the bundle (the thread does not exit: see threads.ts). */
const bothReported = ({ asked }: { asked: string[] }) => asked.filter((a) => a.includes('/read?')).length === 2;

test('installed files: the preload bundle, shared with threads, and single files over the file channel', async () => {
  const out = await h.runInstalled(program, install, '/app/main.js', { holdChannel: true, until: bothReported });
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, 'main: from the bundle\nmain: asked for on its own\nthread: from the bundle, asked for on its own\n');
  const nm = `/__sandburg/nm/${INSTALL_KEY}`;
  // The thread reads the bundled package in its parent's shared memory, and asks for the rest
  // through its parent's channel; nothing installed is asked for over HTTP but the bundle. Each
  // runtime tells the host which of the bundle's files it read (see noteRead).
  const read = `ws ${nm}/read?files=${encodeURIComponent('f/node_modules/bundled/package.json\nt/node_modules/bundled/index.js')}`;
  assert.deepEqual(h.asked.filter((a) => a.includes('/nm/')).sort(), [
    `ws ${nm}/f/node_modules/single/package.json?ahead=1`,
    `ws ${nm}/f/node_modules/single/package.json?ahead=1`,
    read,
    read,
    `ws ${nm}/t/node_modules/single/index.js?ahead=1`,
    `ws ${nm}/t/node_modules/single/index.js?ahead=1`,
  ]);
  assert.equal(h.asked.filter((a) => a.startsWith('http /__sandburg/preload/')).length, 1);
});

test('installed files: what a runtime read before its file channel opened is told to the host once it is open', async () => {
  // The read is reported 500 ms after it (noteRead); the channel opens only after that, when the
  // program asks for it. Before, such a report was dropped: a run whose channel opened late (a
  // loaded machine) left out of its install's next bundle the files it read first.
  const main = { 'main.js': `${CHANNEL_OPEN}\nconsole.log(require('bundled'));\nsetInterval(() => {}, 1000);\nsetTimeout(channelOpen, 700);` };
  const out = await h.runInstalled(main, install, '/app/main.js', { holdChannel: true, until: ({ asked }) => asked.some((a) => a.includes('/read?')) });
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, 'from the bundle\n');
  assert.deepEqual(h.asked.filter((a) => a.startsWith('ws ')), [`ws /__sandburg/nm/${INSTALL_KEY}/read?files=${encodeURIComponent('f/node_modules/bundled/package.json\nt/node_modules/bundled/index.js')}`]);
});

test('installed files: raw files read one after another come with the files after them in their directory', async () => {
  const icons = {
    files: {
      'node_modules/icons/package.json': JSON.stringify({ name: 'icons' }),
      'node_modules/icons/esm/a.js': 'A',
      'node_modules/icons/esm/a.js.map': 'A-map',
      'node_modules/icons/esm/b.js': 'B',
      'node_modules/icons/esm/c.js': 'C',
      'node_modules/icons/esm/d.js': 'D',
    },
    bundled: [],
  };
  // Read out of order once the channel is open, as a bundler does: c.js comes with d.js; a.js with
  // a.js.map and b.js, up to c.js (the runtime has it); each file is read once, and its use told.
  // The program stays (an interval) until the host has heard of the three files' use.
  const main = {
    'main.js': `
      ${CHANNEL_OPEN}
      const fs = require('fs');
      setInterval(() => {}, 1000);
      channelOpen().then(() => {
        const read = (f) => fs.readFileSync('/app/node_modules/icons/esm/' + f, 'utf8');
        console.log(['c.js', 'a.js', 'd.js', 'b.js', 'a.js.map'].map(read).join(' '));
      });`,
  };
  const out = await h.runInstalled(main, icons, '/app/main.js', { holdChannel: true, until: ({ asked }) => asked.filter((a) => a.includes('used=1')).length === 3 });
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, 'C A D B A-map\n');
  const nm = `/__sandburg/nm/${INSTALL_KEY}/f/node_modules/icons/esm`;
  assert.deepEqual(h.asked.filter((a) => a.includes('/icons/esm/')).sort(), [
    `ws ${nm}/a.js.map?used=1`,
    `ws ${nm}/a.js?ahead=1&until=c.js`,
    `ws ${nm}/b.js?used=1`,
    `ws ${nm}/c.js?ahead=1`,
    `ws ${nm}/d.js?used=1`,
  ]);
});

test('installed files: modules pushed with a transformed file are loaded without asking, and their use told', async () => {
  const tool = {
    files: {
      'node_modules/tool/package.json': JSON.stringify({ name: 'tool', main: 'index.js' }),
      'node_modules/tool/index.js': `module.exports = 'tool ' + require('./a.js');`,
      'node_modules/tool/a.js': `module.exports = 'a ' + require('./b.js');`,
      'node_modules/tool/b.js': `module.exports = 'b';`,
    },
    bundled: [],
    pushes: { 'node_modules/tool/index.js': ['node_modules/tool/a.js', 'node_modules/tool/b.js'] },
  };
  const main = { 'main.js': `${CHANNEL_OPEN}\nsetInterval(() => {}, 1000);\nchannelOpen().then(() => console.log(require('tool')));` };
  const out = await h.runInstalled(main, tool, '/app/main.js', { holdChannel: true, until: ({ asked }) => asked.filter((a) => a.includes('used=1')).length === 2 });
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, 'tool a b\n');
  const nm = `/__sandburg/nm/${INSTALL_KEY}/t/node_modules/tool`;
  assert.deepEqual(h.asked.filter((a) => a.includes('/t/')).sort(), [`ws ${nm}/a.js?used=1`, `ws ${nm}/b.js?used=1`, `ws ${nm}/index.js?ahead=1`]);
});

// next dev writes its server's chunks, then requires them once it has compiled the client: the
// runtime has them compiled as they are written (compile-ahead.ts), and uses that compile only for
// the file as it was written.
const writesChunks = {
  'main.js': `
    const fs = require('fs');
    const dir = '/app/.next/dev/server';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/chunk.js', 'module.exports = async () => "written";');
    fs.writeFileSync(dir + '/other.js', 'module.exports = async () => "first";');
    setTimeout(() => {
      // The host is asked for this file now: what it was asked before came first.
      require('single');
      fs.writeFileSync(dir + '/other.js', 'module.exports = async () => "changed";');
      Promise.all([require(dir + '/chunk.js')(), require(dir + '/other.js')()]).then((r) => {
        console.log(r.join(' '));
        process.exit(0);
      });
    }, 500);`,
};

test('installed files: CommonJS files written under the directories named are compiled as they are written, and only used as written', async () => {
  const compiles = (file: string) => h.asked.flatMap((a, i) => (a === `http POST /__sandburg/compile?path=/app/.next/dev/server/${file}` ? [i] : []));
  const marker = () => h.asked.findIndex((a) => a.includes('node_modules/single/'));
  let out = await h.runInstalled(writesChunks, install, '/app/main.js', { compileAhead: ['.next/dev/server'] });
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, 'written changed\n');
  assert.equal(compiles('chunk.js').length, 1);
  assert.ok(compiles('chunk.js')[0] < marker(), h.asked.join('\n'));
  // other.js as first written, then again once it changed (the first compile is not used).
  assert.equal(compiles('other.js').length, 2);
  assert.ok(compiles('other.js')[0] < marker() && compiles('other.js')[1] > marker(), h.asked.join('\n'));
  // Without: compiled when required.
  out = await h.runInstalled(writesChunks, install, '/app/main.js');
  assert.equal(out.stdout, 'written changed\n');
  assert.ok(compiles('chunk.js')[0] > marker(), h.asked.join('\n'));
});

test('installed files: a CommonJS file required as soon as written does not wait for a compile helper that has not started', async () => {
  // As next dev's Pages Router does: its chunks are written and required in one go. A worker the
  // runtime starts does not start while the runtime blocks, so waiting for it would wait it out.
  const main = {
    'main.js': `
      const fs = require('fs');
      fs.mkdirSync('/app/.next/server', { recursive: true });
      fs.writeFileSync('/app/.next/server/page.js', 'module.exports = async () => "now";');
      const t0 = Date.now();
      require('/app/.next/server/page.js')().then((v) => {
        console.log(v, Date.now() - t0 < 5000);
        process.exit(0);
      });`,
  };
  const out = await h.runInstalled(main, install, '/app/main.js', { compileAhead: ['.next/server'] });
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, 'now true\n');
});

test('installed files: a preload bundle the page downloaded is not requested again', async () => {
  const out = await h.runInstalled(program, install, '/app/main.js', { prefetch: true, holdChannel: true, until: bothReported });
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, 'main: from the bundle\nmain: asked for on its own\nthread: from the bundle, asked for on its own\n');
  // One request for the bundle: the page's.
  assert.deepEqual(h.asked.filter((a) => a.startsWith('http /__sandburg/preload/')).map((a) => a.endsWith('?by=page')), [true]);
  assert.deepEqual(h.asked.filter((a) => a.startsWith('http /__sandburg/nm/')), []);
});

test('threads: a napi-rs WebAssembly thread (wasi-worker.mjs) boots no spare runtimes; another thread does', async () => {
  // Each thread loads worker_threads, as napi-rs' wasi-worker.mjs does; the program waits for the
  // runtimes they start to load. emnapi's threads ask the thread that loaded the build to spawn
  // more, so spares of their own are never taken.
  const thread = `require('worker_threads').parentPort.postMessage('up');`;
  const spares = async (entry: string) => {
    const files = { ...install.files, [`node_modules/${entry}`]: thread };
    const main = {
      'main.js': `
        const { Worker } = require('worker_threads');
        setTimeout(() => {
          const w = new Worker('/app/node_modules/${entry}');
          w.on('message', (m) => { console.log(m); setTimeout(() => process.exit(0), 1000); });
        }, 300);`,
    };
    const out = await h.runInstalled(main, { files, bundled: [] }, '/app/main.js');
    assert.equal(out.fatal, null);
    assert.equal(out.stdout, 'up\n');
    return h.asked.filter((a) => a === 'http /__sandburg/node-spare.js').length;
  };
  const other = await spares('@demo/tool/worker.mjs');
  const wasi = await spares('@demo/tool-wasm32-wasi/wasi-worker.mjs');
  // The program's spares (and their replacements) are the same in both runs.
  const warm = await h.page.evaluate(() => Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4)));
  assert.equal(other - wasi, warm, `spares started: ${other} with another thread, ${wasi} with a WebAssembly thread`);
});

test('installed files: the bundle files a runtime read are told in reports that fit a frame of the file channel', async () => {
  // 100 files with long paths (~800 characters each): reports of 100 files were one 80 KB frame,
  // over the channel's MAX_FRAME, and the host closed the channel (later files came over HTTP).
  const dir = `node_modules/long/${Array.from({ length: 4 }, (_, i) => String(i).repeat(200)).join('/')}`;
  const names = Array.from({ length: 100 }, (_, i) => `${dir}/f${i}.js`);
  const files: Record<string, string> = { 'node_modules/single/package.json': install.files['node_modules/single/package.json'], 'node_modules/single/index.js': install.files['node_modules/single/index.js'] };
  for (const [i, name] of names.entries()) files[name] = `module.exports = ${i};`;
  const main = {
    'main.js': `
      setTimeout(() => {
        let sum = 0;
        for (let i = 0; i < 100; i++) sum += require('/app/${dir}/f' + i + '.js');
        console.log(sum);
        setTimeout(() => { console.log(require('single')); setTimeout(() => process.exit(0), 700); }, 100);
      }, 300);`,
  };
  const out = await h.runInstalled(main, { files, bundled: names }, '/app/main.js');
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, '4950\nasked for on its own\n');
  const reported = h.asked.filter((a) => a.startsWith(`ws /__sandburg/nm/${INSTALL_KEY}/read?files=`)).flatMap((a) => decodeURIComponent(a.slice(a.indexOf('=') + 1)).split('\n'));
  assert.deepEqual(reported.sort(), names.map((n) => `t/${n}`).sort());
  assert.deepEqual(h.asked.filter((a) => a.startsWith('http /__sandburg/nm/')), []);
});
