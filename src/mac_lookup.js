const toMAC = require('@network-utils/arp-lookup').toMAC;
const os = require('os');
const dgram = require('dgram');

function ping(ip)
{
  const socket = dgram.createSocket('udp4');

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      socket.close();
      resolve();
    }, 100);
    socket.bind();
    socket.send('ping', 7, ip);
  });
}

async function lookupMACAddress(ip)
{
  // the IP could be local
  const interfaces = os.networkInterfaces();

  for (let ifname in interfaces)
  {
    const addresses = interfaces[ifname];

    for (let i = 0; i < addresses.length; i++)
    {
      const info = addresses[i];

      if (info.address === ip) return info.mac;
    }
  }

  let mac = await toMAC(ip);

  // we found it in the ARP table
  if (mac) return mac;

  // we send one ping message and assume that the ip will
  // then ænd up in our arp table
  await ping(ip);

  return await toMAC(ip);
}

module.exports = {
  lookupMACAddress: lookupMACAddress,
};
