// An unref'd server does not keep the process alive; one ref'd again does, until it closes.
const http = require('http');
process.on('exit', () => console.log('exit'));
http.createServer().listen(3082).unref();
const again = http.createServer().listen(3083).unref().ref();
setTimeout(() => {
  console.log('closing the ref\'d one');
  again.close();
}, 300);
