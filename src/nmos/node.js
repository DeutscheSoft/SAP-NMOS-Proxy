const RegistryResolver = require('./discovery.js').RegistryResolver;
const connect = require('connect');
const util = require('util');
const http = require('http');
const dnssd = require('dnssd');

class Sender
{
}

class Device
{
  constructor(node, info)
  {
    this.node = node;
    this.senders = new Map();
  }

  makeSender(info)
  {

  }
}

function get_first_public_ip(family)
{
  const os = require('os');

  if (!family) family = 'IPv4';
  let ip;

  const interfaces = os.networkInterfaces();

  for (let ifname in interfaces)
  {
    const addresses = interfaces[ifname];

    for (let i = 0; i < addresses.length; i++)
    {
      const info = addresses[i];
      if (info.internal) continue;
      if (info.family !== family) continue;

      return info.address;
    }
  }
}

class Node
{
  constructor(options)
  {
    const ip = options.ip || get_first_public_ip();
    const http_port = options.http_port || 80;

    const info = Object.assign({
      version: util.format('%d:%d', Date.now(), 0),
      label: '',
      description: '',
      tags: {},
      href: 'http://' + ip + ':' + http_port,
      caps: {},
      api: {
        "versions": [ "v1.3" ],
        "endpoints": [
          {
            "host": ip,
            "port": http_port,
            "protocol": "http",
          }
        ],
      },
      services: [],
      clocks: [],
      interfaces: [],
    }, options.info||{});

    const dnssd_options = Object.assign({
      interface: ip,
    }, options.dnssd || {});

    this.info = info;
    this.advertisement = new dnssd.Advertisement(dnssd.tcp('nmos-node'), http_port);
    this.resolver = new RegistryResolver(dnssd_options);

    const app = connect().use('/self', (req, res, next) => {
      console.log("got request for /self");
      res.end(JSON.stringify(this.info), 'applicatio/json'); 
    });

    this.http = http.createServer(app).listen(http_port, ip);
    const register = () => {
      this.resolver.forEach((api, url) => {
        api.registerNode(this.info);
      });
    };

    register();

    this.heartbeat_id = setInterval(register, 5000);
  }

  close()
  {
    this.resolver.close();
    this.http.close();
    this.advertisement.close();
    clearInterval(this.heartbeat_id);
  }
}

module.exports = Node;
