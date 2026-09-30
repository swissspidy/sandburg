// `require('process/')` from polyfills resolves here: the (proxied) runtime process.
module.exports = require('./globals-shim.ts').process;
