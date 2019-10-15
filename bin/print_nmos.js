const nmos = require('../src/nmos.js');
const UnionSet = require('../src/dynamic_set.js').UnionSet;

const queries = new nmos.Discovery.QueryResolver();
const registries = new nmos.Discovery.RegistryResolver();
const nodes = new nmos.Discovery.NodeResolver();

const queries_and_nodes = queries.union(nodes);

const senders = new UnionSet();

queries_and_nodes.forEachAsync((api, id, set) => {
  let _senders;

  console.log('api found at: %s', api.url);

  const start = () => {
    api = set.get(id);
    _senders = api.senders();
    senders.addSet(_senders);
  };
  const stop = () => {
    senders.removeSet(_senders);
    _senders.close();
    _senders = null;
    api = null;
  };

  set.waitForUpdate(id).then(() => {
    stop();
    start();
  });
  set.waitForDelete(id).then(stop);
  start();
});

senders.forEachAsync(async (sender, id) => {
  console.log('sender found in registry: %o', sender);
  console.log('SDP: %s', await sender.fetchManifest());
});
