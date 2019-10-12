const uuid = require('uuid/v5');
const util = require('util');

const Node = require('../src/nmos/node.js');

const node_id = 'd6fe88a0-aac7-4f53-8de3-9046fcc4b766';

const node = new Node({
  http_port: 1080,
  info: {
    id: node_id,
    label: 'SAP-to-NMOS proxy',
    description: 'This node proxies between SAP and NMOS.',
  },
});

const device = node.makeDevice({
  id: uuid('device:192.168.178.134', node_id),
  version: util.format('%d:%d', Date.now(), 0),
  label: 'my device',
  description: '',
  tags: {},
  type: "urn:x-nmos:device:audio",
  senders: [],
  receivers: [],
  controls: [],
});
