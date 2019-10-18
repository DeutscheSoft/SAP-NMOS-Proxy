#!/usr/bin/env node

const argparse = require('argparse');
const uuid = require('uuid/v5');

const Interfaces = require('../src/interfaces.js').Interfaces;
const NMOS = require('../src/nmos.js');
const SDP = require('../src/sdp.js');
const SAP = require('../src/sap.js');
const Cleanup = require('../src/event_helpers.js').Cleanup;

const argumentParser = new argparse.ArgumentParser({
  version: '0.0.1',
  addHelp:true,
  description: 'SAP to NMOS proxy.'
});

argumentParser.addArgument(
  [ '-i', '--interface' ],
  {
    help: 'Network interface to use. Either interface name or ip address.'
  }
);
const args = argumentParser.parseArgs();

function interface_start_address(interface)
{
  const ip = interface.address.split('.').map((v) => parseInt(v));
  const netmask = interface.netmask.split('.').map((v) => parseInt(v));

  for (let i = 0; i < ip.length; i++)
  {
    ip[i] &= netmask[i];
  }

  return ip.join('.');
}

const interfaces = new Interfaces().filter((ifname, interface) => {
  return (args.interface === null ||
          args.interface === ifname ||
          args.interface === interface.address);
});

// The namespace ID of the nmos proxy. We use this as the base of
// all registrations. It will be parametrized using
//  * ip network the proxy is operating on
//  * NMOS resource ids
const PROXY_NAMESPACE = 'd6fe88a0-aac7-4f53-8de3-9046fcc4b766';

interfaces.forEachAsync((network_interface, ifname) => {

  console.log('Starting proxy on interface %s', ifname);

  const ip = network_interface.address;

  const node_id = uuid('node:'+interface_start_address(network_interface),
                       PROXY_NAMESPACE);

  const node = new NMOS.Node({
    ip: ip,
    info: {
      id: node_id,
      label: 'SAP to NMOS proxy',
      description: 'This node proxies between SAP and NMOS.',
    },
  });

  const sap_port = new SAP.Port(ip);
  const sap_announcements = new SAP.Announcements(sap_port);
  const ownAnnouncements = new SAP.OwnAnnouncements();
  sap_announcements.ignoreFrom(ownAnnouncements);

  const all_senders = NMOS.Discovery.AllSenders({ interface: ip });

  const cleanup = new Cleanup();

  // NMOS -> SAP
  cleanup.add(all_senders.forEachAsync((sender, sender_id) => {
    console.log('Found NMOS sender: %o\n', sender);

    let sdp = null;
    let closed = false;

    const task = async () => {
      do
      {
        const change_p = all_senders.waitForChange(sender_id);
        if (sender.info.transport.startsWith('urn:x-nmos:transport:rtp'))
        {
          try
          {
            _sdp = new SDP(await sender.fetchManifest());
            if (closed) return;
            ownAnnouncements.add(_sdp);
            console.log('Created SAP announcement for %o', _sdp.id);
            sdp = _sdp;
          }
          catch (err)
          {
            console.warn('announceing SAP failed:', err);
          }
        }
        else if (sdp)
        {
          ownAnnouncements.delete(sdp);
          sdp = null;
        }

        try
        {
          sender = await change_p;
          if (closed) return;
        }
        catch (err)
        {
          // end task
          return;
        }
        sender = senders.get(sender_id);
      } while (true);
    };

    // run
    task().catch((err) => { console.error('sap announcement task failed.', err); });

    return () => {
      closed = true;
      if (sdp)
        ownAnnouncements.delete(sdp);
    };
  }));

  // SAP -> NMOS

  const sdpToNMOSDevice = (sdp) => {
    const id = uuid('device:'+sdp.origin_addr, node_id);

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

    return info;
  };

  const sdpToNMOSSender = (sdp) => {
    const id = uuid('sender:'+sdp.id, node_id);

    const info = {
      id: id,
      version: util.format('%d:%d', Date.now(), 0),
      label: sdp.name,
      sdp: sdp,
      description: '',
      tags: {},
      flow_id: id,
      transport: 'urn:x-nmos:transport:rtp.mcast',
      interface_bindings: [],
      subscription: { receiver_id: null, active: false }
    };

    return info;
  };

  cleanup.add(sap_announcements.forEachAsync((sdp, sdp_id) => {
    console.log('Observed SAP announcement %o', sdp);
    let closed = false;

    let device = node.makeDevice(sdpToNMOSDevice(sdp));
    console.log('Created NMOS device %o', device.json);

    let sender = device.makeRTPSender(sdpToNMOSSender(sdp));
    console.log('Created NMOS sender %o', sender.json);

    const task = async () => {
      do
      {
        try
        {
          sdp = await sap_announcements.waitForChange(sdp_id);
        }
        catch (err)
        {
          // was deleted
          return;
        }

        device.update(sdpToNMOSDevice(sdp));
        sender.update(sdpToNMOSSender(sdp));
      } while (true);
    };

    task();

    return () => {
      closed = true;
      sender.close();
      // FIXME: devices are shared. we could delete them using refcounting
      // but until we have that implemented we just keep it around.
      // device.close();
    };
  }));

  return () => {
    cleanup.close();
    all_senders.close();
    node.close();
    sap_announcements.close();
    sap_port.close();
    ownAnnouncements.close();
  };
});
