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

// random
const PROXY_NAMESPACE = 'd6fe88a0-aac7-4f53-8de3-9046fcc4b766';

function NMOS_node()
{
  const id = uuid('proxy', PROXY_NAMESPACE);

  return {
    id: id,
    version: util.format('%d:%d', Date.now(), 0),
    label: 'SAP-to-NMOS proxy',
    description: '',
    tags: {},
    href: 'http://example.org',
    caps: {},
    api: {
      "versions": [ "v1.3" ],
      "endpoints": [],
    },
    services: [],
    clocks: [],
    interfaces: [],
  };
}

function SDP_to_NMOS_device(sdp)
{
  const id = uuid('device:'+sdp.origin_addr, PROXY_NAMESPACE);

  console.log(sdp.raw);

  const info = {
    id: id,
    version: util.format('%d:%d', Date.now(), 0),
    label: sdp.name.split(':')[0].trim(),
    description: '',
    tags: {},
    type: "urn:x-nmos:device:audio",
    node_id: PROXY_NAMESPACE,
    senders: [],
    receivers: [],
    controls: [],
  };

  console.log(info);

  return info;
}

function SDP_to_NMOS_sender(sdp)
{

  const id = uuid('sender:'+sdp.id, PROXY_NAMESPACE);

  const info = {
    id: id,
    version: util.format('%d:%d', Date.now(), 0),
    label: '',
    description: '',
    tags: {},
    flow_id: id,
    transport: 'urn:x-nmos:transport:rtp.mcast',
    manifest_href: 'http://example.com/foo.sdp',
    interface_bindings: [],
    subscription: { receiver_id: null, active: false }
  };

  return info;
}

function announce_to_registry(sap_announcements, registry)
{
  const cleanup = new Cleanup();

  registry.registerNode(NMOS_node()).then(() => {
    cleanup.add(sap_announcements.forEachAsync(async (sdp, id) => {
      const delete_p = sap_announcements.waitForDelete(id);
      const cleanup_p = cleanup.whenClosed();

      // register device once.
      
      const device_info = SDP_to_NMOS_device(sdp);
      await registry.registerDevice(device_info);

      do
      {
        console.log('publishing %o to nmos registry %o', sdp.id, registry.url.href);

        try
        {
          const info = SDP_to_NMOS_device(sdp);
          info.device_id = device_info.id;
          console.log('NMOS device info: %o', info);
          await registry.registerSender(info);
        }
        catch(err)
        {
          console.error("Register failed: ", err);
        }

        const update_p = sap_announcements.waitForUpdate(id);



        // item was deleted
        switch (await whenOne([ update_p, delete_p, cleanup_p ]))
        {
        case 0: // update
          console.log('item was updated', id);
          sdp = await update_p;
          break;
        case 1: // delete
          console.log('removing %o from nmos registry %o.', sdp.id, registry.url.href);
          return;
        case 2: // cleanup
          console.log('cleanup called');
          return;
        }
      }
      while (true);
    }));
  });

  return cleanup;
}


module.exports = {
  announce_to_registry: announce_to_registry,
};
