#!/usr/bin/env node

const argparse = require('argparse');
const uuid = require('uuid/v5');

const Interfaces = require('../src/interfaces.js').Interfaces;
const NMOS = require('../src/nmos.js');
const SDP = require('../src/sdp.js');
const SAP = require('../src/sap.js');

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

  const all_senders = NMOS.Discovery.AllSenders({ interface: ip });

  all_senders.forEachAsync((sender) => {
    console.log('Found NMOS sender: %o\n', sender);
  });

  return () => {
    all_senders.close();
    node.close();
    sap_announcements.close();
    sap_port.close();
  };
});
