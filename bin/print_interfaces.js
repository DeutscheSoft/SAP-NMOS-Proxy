const Interfaces = require('../src/interfaces.js').Interfaces;

const interfaces = new Interfaces();

interfaces.forEachAsync((info, ifname) => {
  console.log('%s -> %o', ifname, info);
});
