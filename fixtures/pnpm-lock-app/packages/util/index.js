const escape = require('escape-html');

exports.versionOf = (name) => require(`${name}/package.json`).version;
exports.escape = escape;
exports.escapeVersion = require('escape-html/package.json').version;
