const SAP = require('../src/sap.js');
const announce_to_registry = require('../src/sap_to_nmos.js').announce_to_registry;
const NMOS = require('../src/nmos.js');

const port = new SAP.Port();
const announcements = new SAP.Announcements(port);

const nmos_registries = new NMOS.RegistryResolver();

const cleanup = nmos_registries.forEachAsync(async (api, url) => {
  console.log('Found NMOS registry at %o', url);


  // TODO: add this local cleanup object to the top level cleanup
  const cleanup = announce_to_registry(announcements, api);

  await nmos_registries.waitForDelete(url);

  cleanup.close();
});


cleanup.add(() => port.close());
cleanup.whenClosed().then(() => console.log('cleanup.\n'));
