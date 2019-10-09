const nmos = require('../src/nmos.js');

const queries = new nmos.QueryResolver();
const registries = new nmos.RegistryResolver();

registries.on('add', (url) => console.log('registry found: %o', url));
queries.on('add', async (url, api) => {
  console.log('senders: ', await api.senders());
  console.log('receivers: ', await api.receivers());
});
