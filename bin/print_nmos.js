const nmos = require('../src/nmos.js');

const queries = new nmos.Discovery.QueryResolver();
const registries = new nmos.Discovery.RegistryResolver();
const nodes = new nmos.Discovery.NodeResolver();

queries.forEachAsync((api, url) => {
  const senders = api.senders();

  console.log('registry found: %o', url);

  senders.forEachAsync(async (sender, id) => {
    console.log('sender found in registry: %o', sender);
    console.log('SDP: %s', await sender.fetchManifest());
  });
});

nodes.forEachAsync((api, url) => {
  const senders = api.senders();

  console.log('node found: %o', url);

  senders.forEachAsync(async (sender, id) => {
    console.log('sender found in node: %o', sender);
    console.log('SDP: %s', await sender.fetchManifest());
  });
});
