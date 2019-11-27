#!/usr/bin/env node

const fs = require('fs');

const argparse = require('argparse');
const uuid = require('uuid/v5');

const Interfaces = require('../src/interfaces.js').Interfaces;
const Proxy = require('../').Proxy;

const Log = require('../src/logger.js');
const SDP = require('../src/sdp.js');

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

argumentParser.addArgument(
  [ '-l', '--loglevel' ],
  {
    help: 'Set log level. 0: errors, 1: warnings, 2: info, 3: debug.',
  }
);

argumentParser.addArgument(
  [ '--sdp-file' ],
  {
    help: 'Comma seperated list of SDP files. They are added to the proxy.',
  }
);

const args = argumentParser.parseArgs();

const interfaces = new Interfaces();

const interface_filter = (ifname, interface) => {
  return (args.interface === null ||
          args.interface === ifname ||
          args.interface === interface.address);
};

if (args.hasOwnProperty('loglevel')
    && parseInt(args.loglevel).toString() === args.loglevel) {
  Log.level = parseInt(args.loglevel);
}

const cleanup = interfaces.filter(interface_filter).forEachAsync((network_interface, ifname) => {
  const proxy = new Proxy({
    interface: network_interface,
  });

  if (args.sdp_file)
  {
    args.sdp_file.split(',').forEach((fname) => {
      const sdp_file = fs.readFileSync(fname, 'utf8');
      const sdp = new SDP(sdp_file);

      Log.info('Using SDP file %o', fname);

      proxy.sdpStringsToNMOS.add(sdp.id, sdp);
    });
  }

  proxy.on('log', (...args) => {
    console.log(...args);
  });

  return () => {
    proxy.close();
  };
});
