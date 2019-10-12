const Node = require('../src/nmos/node.js');

const node = new Node({
  http_port: 1080,
  info: {
    id: 'd6fe88a0-aac7-4f53-8de3-9046fcc4b766',
    label: 'SAP-to-NMOS proxy',
    description: 'This node proxies between SAP and NMOS.',
  },
});
