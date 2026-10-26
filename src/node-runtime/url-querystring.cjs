// What the `url` polyfill requires as `qs` (bundle.ts): Node's url.parse(…, true) and url.format
// use node:querystring, which parses `a[b]=1` as the key `a[b]` and repeats a key for each item of
// an array, with no limit on either. qs (url@0.11.4's choice) nests objects, turns an array of more
// than 20 into an object, and with its dependencies was ~70 KB of every runtime's script.
const querystring = require('querystring-es3');

module.exports = {
  parse: (s) => querystring.parse(s),
  stringify: (o) => querystring.stringify(o),
};
