const crypto = require('crypto');
const uuid = require('uuid/v5');
const util = require('util');
const performance = require('perf_hooks').performance;

const Cleanup = require('./event_helpers.js').Cleanup;

function whenOne(it)
{
  return new Promise((resolve, reject) => {
    it.forEach((p, index) => {
      p.then(() => resolve(index), (e) => resolve(index));
    });
  });
}

function SDP_to_NMOS_sender(sdp)
{
  // random
  const PROXY_NAMESPACE = 'd6fe88a0-aac7-4f53-8de3-9046fcc4b766';

  const id = uuid(sdp.id, PROXY_NAMESPACE);

  return {
    id: id,
    version: util.format('%d:%d', Date.now(), 0),
    description: '',
    label: '',
    flow_id: id,
    tags: [ 'sap-proxy' ],
    transport: 'urn:x-nmos:transport:rtp.mcast',
  };
}

function announce_to_registry(sap_announcements, registry)
{
  const cleanup = new Cleanup();

  cleanup.add(sap_announcements.forEachAsync(async (sdp, id) => {
    const delete_p = sap_announcements.waitForDeletion(id);
    const cleanup_p = cleanup.whenClosed();

    do
    {
      console.log('publishing %o to nmos registry %o', sdp.id, registry.url.href);

      const update_p = sap_announcements.waitForUpdate(id);

      const info = SDP_to_NMOS_sender(sdp);

      console.log('NMOS: %o', info);

      // item was deleted
      switch (await whenOne([ update_p, delete_p, cleanup_p ]))
      {
      case 0: // update
        console.log('item was updated', id);
        sdp = await update_p;
        break;
      case 1:
        console.log('removing %o from nmos registry %o.', sdp.id, registry.url.href);
        return;
      case 2:
        console.log('cleanup called');
        return;
      }
    }
    while (true);
  }));

  return cleanup;
}


module.exports = {
  announce_to_registry: announce_to_registry,
};
