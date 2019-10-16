const SAP = require('../src/sap.js');
const SDP = require('../src/sdp.js');

var port;

if (process.argv.length > 2)
  port = new SAP.Port(process.argv[2]);
else
  port = new SAP.Port();

port.on('error', (e) => {
  console.error(e);
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

const ownAnnouncements = new SAP.OwnAnnouncements();
ownAnnouncements.add(new SDP(SDP_STR));

let cleanup;

port.onReady().then(() => {
  console.log("PORT IS READY");

  const announcements = new SAP.Announcements(port);
  announcements.ignoreFrom(ownAnnouncements);

  announcements.on('add', (id, sdp, packet) => {
    console.log((new Date()).toString());
    console.log('+++ Received SAP (id=%o) from %s with SDP payload:\n  %s\n',
                packet.id,
                packet.source, sdp.toString().replace(/\n/g, '\n  '));
  });
  announcements.on('delete', (id, sdp, packet, explicit) => {
    console.log((new Date()).toString());
    console.log('--- %s SAP (id=%o) from %s with SDP payload:\n  %s\n',
                explicit ? "Received" : "Timed out",
                packet.id,
                packet.source, sdp.toString().replace(/\n/g, '\n  '));
  });

  cleanup = ownAnnouncements.announceToPort(port);
  setTimeout(() => cleanup.close(), 95 * 1000);

}).catch(e => console.error(e));
