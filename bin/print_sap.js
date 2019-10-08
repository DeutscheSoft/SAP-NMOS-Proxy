const SAP = require('../src/sap.js');

const port = new SAP.Port();

port.on('message', (packet) => {
  console.log('Received SAP packet from %s with SDP payload:\n  %s\n',
              packet.source, packet.sdp.replace(/\n/g, '\n  '));
});

port.on('error', (e) => {
  console.error(e);
});
