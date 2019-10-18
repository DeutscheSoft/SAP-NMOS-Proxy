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
      label: 'SAP-to-NMOS proxy',
      description: 'This node proxies between SAP and NMOS.',
    },
  });

  const sap_port = new SAP.Port(ip);
  const sap_announcements = new SAP.Announcements(sap_port);
  const ownAnnouncements = new SAP.OwnAnnouncements();
  sap_announcements.ignoreFrom(ownAnnouncements);

  const all_senders = NMOS.Discovery.AllSenders({ interface: ip });

  const cleanup = new Cleanup();

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

  cleanup.add(sap_announcements.forEachAsync((sdp, id) => {
    console.log('SAP: %o', sdp);
    // TODO: create NMOS sender
    return () => {
      // TODO: delete NMOS node
    };
  }));

  return () => {
    cleanup.close();
    all_senders.close();
    node.close();
    sap_announcements.close();
    sap_port.close();
  };
});
