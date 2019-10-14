const nmos = require('../src/nmos.js');

const queries = new nmos.Discovery.QueryResolver();
const registries = new nmos.Discovery.RegistryResolver();

queries.forEachAsync((api, url) => {
  const senders = api.senders();

  console.log('registry found: %o', url);

  senders.forEachAsync((sender, id) => {
    console.log('sender found: %o', sender);
  });
});
