const uuid = require('uuid/v5');
const util = require('util');

const Node = require('../src/nmos/node.js');
const SDP = require('../src/sdp.js');

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

const SDP_STR = [
  "v=0",
  "o=- 29054176 29054179 IN IP4 192.168.178.134",
  "s=Y001-Yamaha-Ri8-D-14e622 : 32",
  "c=IN IP4 239.69.205.203/32",
  "t=0 0",
  "a=keywds:Dante",
  "m=audio 5004 RTP/AVP 96",
  "i=1 channels: 02",
  "a=recvonly",
  "a=rtpmap:96 L24/48000/1",
  "a=ptime:1",
  "a=ts-refclk:ptp=IEEE1588-2008:00-1D-C1-FF-FE-14-E6-22:0",
  "a=mediaclk:direct=750129611"
].join('\r\n');

const sdp = new SDP(SDP_STR);

const sender = device.makeSender({
  id: uuid('sender:'+sdp.id, node_id),
  version: util.format('%d:%d', Date.now(), 0),
  label: '',
  description: '',
  tags: {},
  flow_id: uuid('flow:'+sdp.id, node_id),
  transport: 'urn:x-nmos:transport:rtp.mcast',
  manifest_href: 'http://example.com/foo.sdp',
  interface_bindings: [],
  subscription: { receiver_id: null, active: false }
});
