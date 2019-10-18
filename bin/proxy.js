#!/usr/bin/env node

const argparse = require('argparse');
const uuid = require('uuid/v5');

const Interfaces = require('../src/interfaces.js').Interfaces;
const Proxy = require('../src/proxy.js');

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

const interfaces = new Interfaces();

const interface_filter = (ifname, interface) => {
  return (args.interface === null ||
          args.interface === ifname ||
          args.interface === interface.address);
};


const cleanup = interfaces.filter(interface_filter).forEachAsync((network_interface, ifname) => {
  const proxy = new Proxy({
    interface: network_interface,
  });

  proxy.on('log', (...args) => {
    console.log(...args);
  });

  return () => {
    proxy.close();
  };
});
