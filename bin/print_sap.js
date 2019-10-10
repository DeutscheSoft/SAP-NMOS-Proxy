const SAP = require('../src/sap.js');

var port;

if (process.argv.length > 2)
  port = new SAP.Port(process.argv[2]);
else
  port = new SAP.Port();

const announcements = new SAP.Announcements(port);

announcements.on('add', (id, sdp, packet) => {
  console.log('+++ Received SAP (id=%o) from %s with SDP payload:\n  %s\n',
              packet.id,
              packet.source, sdp.toString().replace(/\n/g, '\n  '));
});
announcements.on('delete', (id, sdp, packet) => {
  console.log('--- Received SAP (id=%o) from %s with SDP payload:\n  %s\n',
              packet.id,
              packet.source, sdp.toString().replace(/\n/g, '\n  '));
});

port.on('error', (e) => {
  console.error(e);
});
