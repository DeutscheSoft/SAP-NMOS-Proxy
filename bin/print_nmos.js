const NMOS = require('../src/nmos.js');
const UnionSet = require('../src/dynamic_set.js').UnionSet;

const senders = new NMOS.Discovery.AllSenders();

senders.forEachAsync(async (sender, id) => {
  console.log('sender found in registry: %o', sender);
  console.log('SDP: %s', await sender.fetchManifest());
});
