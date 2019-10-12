const nmos = require('../src/nmos.js');

const queries = new nmos.QueryResolver();
const registries = new nmos.RegistryResolver();

queries.forEachAsync((api, url) => {
  const senders = api.senders();

  console.log('registry found: %o', url);

  senders.forEachAsync((sender, id) => {
    console.log('sender found: %o', sender);
  });
});
