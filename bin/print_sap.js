const SAP = require('../src/sap.js');

const port = new SAP.Port();
const announcements = new SAP.Announcements(port);

announcements.on('add', (id, sdp, packet) => {
  console.log('Received SAP announcements (id=%o) from %s with SDP payload:\n  %s\n',
              packet.id,
              packet.source, sdp.replace(/\n/g, '\n  '));
});

port.on('error', (e) => {
  console.error(e);
});
