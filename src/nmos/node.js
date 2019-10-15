const assert = require('assert');
const Events = require('events');
const util = require('util');
const http = require('http');

const connect = require('connect');
const dnssd = require('dnssd');

const Cleanup = require('../event_helpers.js').Cleanup;
const DynamicSet = require('../dynamic_set.js');
const RegistryResolver = require('./discovery.js').RegistryResolver;
const SDP = require('../sdp.js');

function whenOne(it)
{
  return new Promise((resolve, reject) => {
    it.forEach((p, index) => {
      p.then(() => resolve(index), (e) => resolve(index));
    });
  });
}

function deep_equal(a, b)
{
  try
  {
    assert.deepStrictEqual(a, b, '');
    return true;
  }
  catch (e)
  {
    return false;
  }
}

function delay(timeout)
{
  return new Promise((resolve, reject) => {
    setTimeout(resolve, timeout);
  });
}

async function retry(task, n, timeout)
{
  let err;

  if (!n) n = 3;
  if (!timeout) timeout = 1000;

  for (let i = 0; i < n; i++)
  {
    try
    {
      return await task();
    }
    catch (e)
    {
      err = e;
      await delay(timeout);
    }
  }

  throw err;
}

class Resource extends Events
{
  getNode()
  {
    let tmp = this;

    while (tmp !== null)
    {
      if (tmp instanceof Node) return tmp;
      tmp = tmp.parent;
    }

    return null;
  }

  get json()
  {
    return this.info;
  }

  get id()
  {
    return this.info.id;
  }

  constructor(parent, info)
  {
    super();
    this.parent = parent;
    this.info = Object.assign({}, info);
  }

  update(info)
  {
    if (info.id && info.id !== this.id)
      throw new Error('ID cannot be changed.');

    const n = Object.assign({}, this.info, info);
    if (deep_equal(n, this.info))
      return;
    this.info = n;
    this.emit('update');
  }

  close()
  {
    this.emit('close');
  }

  registerSelf(api)
  {
    return Promise.reject(new Error('Not implemented.'));
  }

  unregisterSelf(api)
  {
    return Promise.reject(new Error('Not implemented.'));
  }

  startChildRegistration(api)
  {
    // nothing to do on cleanup.
    return () => {};
  }

  startRegistration(api)
  {
    const cleanup = new Cleanup();

    cleanup.whenClosed().then(async () => {
      try
      {
        await unregisterSelf(api);
      } catch (err) {
        console.error('Failed to remove device: %o', this.id);
      }
    });

    this.on('close', () => cleanup.close());

    (async () => {
      await retry(() => this.registerSelf(api), 3, 1000);

      cleanup.subscribe(this, 'update', async () => {
        try
        {
          await retry(() => this.registerSelf(api), 3, 1000);
        }
        catch (err)
        {
          console.error('Update of %o failed: %o', this.info, err);
          cleanup.close();
        }
      });

      // start registering children.
      cleanup.add(this.startChildRegistration(api));
    })().catch((err) => {
      console.error('Registration of %o failed: %o', this.info, err);
      cleanup.close();
    });

    return cleanup;
  }
}

class ResourceSet extends DynamicSet
{
  constructor(type, parent)
  {
    super();
    this.type = type;
    this.parent = parent;
  }

  create(info, type)
  {
    const id = info.id;

    if (this.has(id))
    {
      throw new Error("Resource with given id already exists.");
    }

    if (!type) type = this.type;

    const resource = new type(this.parent, info);

    resource.on('close', () => {
      this.delete(id);
    });

    this.add(id, resource);

    return resource;
  }

  make(info, type)
  {
    const resource = this.get(info.id);

    if (!resource)
      return this.create(info, type);

    resource.update(info);

    return resource;
  }

  startRegistration(api)
  {
    const cleanup = new Cleanup();

    cleanup.add(this.forEachAsync((entry, id) => {
      cleanup.add(entry.startRegistration(api));
    }));

    return cleanup;
  }
}

class Sender extends Resource
{
  get device()
  {
    return this.parent;
  }

  registerSelf(api)
  {
    return api.registerSender(this.json);
  }

  unregisterSelf(api)
  {
    return api.deleteSender(this.json);
  }

  getManifest()
  {
    return null;
  }
}

class RTPSender extends Sender
{
  get json()
  {
    return Object.assign({
      manifest_href: this.getNode().getManifestUrl(this.id, 'sdp'),
    }, this.info);
  }

  constructor(parent, info)
  {
    const sdp = info.sdp;
    if (!(sdp instanceof SDP))
      throw new TypeError('Expected type SDP in field \'sdp\'.');
    delete info.sdp;
    super(parent, info);
    this.sdp = sdp;
  }

  getManifest()
  {
    return [ 'application/sdp', this.sdp.raw ];
  }
}

class Senders extends ResourceSet
{
  constructor(device)
  {
    super(Sender, device);
  }
}

class Device extends Resource
{
  get json()
  {
    return Object.assign({}, this.info, {
      senders: Array.from(this.senders.keys()),
    });
  }

  get node()
  {
    return this.parent;
  }

  constructor(node, info)
  {
    super(node, info);
    this.senders = new Senders(this);
  }

  getSender(id)
  {
    return this.senders.get(id);
  }

  registerSelf(api)
  {
    return api.registerDevice(this.json);
  }

  unregisterSelf(api)
  {
    return api.deleteDevice(this.json);
  }

  startChildRegistration(api)
  {
    return this.senders.startRegistration(api);
  }

  makeSender(info)
  {
    info = Object.assign({}, info, {
      device_id: this.id,
    });
    return this.senders.make(info);
  }

  makeRTPSender(info)
  {
    info = Object.assign({}, info, {
      device_id: this.id,
    });
    return this.senders.make(info, RTPSender);
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

class Devices extends ResourceSet
{
  constructor(node)
  {
    super(Device, node);
  }
}

class Node extends Resource
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

    super(null, info);

    this.advertisement = new dnssd.Advertisement(dnssd.tcp('nmos-node'), http_port);
    this.resolver = new RegistryResolver(dnssd_options);
    this.cleanup = new Cleanup();
    this.devices = new Devices(this);

    const app = connect()
    .use('/x-nmos/node/v1.3/self', (req, res, next) => {
      res.end(JSON.stringify(this.info), 'application/json');
    })
    .use('/x-nmos/node/v1.3/senders', (req, res, next) => {
      const sender_id = req.url.substr(1);

      if (sender_id.length)
      {
        let found = false;

        this.devices.forEach((device) => {
          if (found) return;
          const sender = device.getSender(sender_id);

          if (!sender) return;

          found = true;
          res.end(JSON.stringify(sender.json), 'application/json');
        });

        if (!found)
        {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found.');
        }
      }
      else
      {
        const senders = [];

        this.devices.forEach((device) => {
          device.senders.forEach((sender, id) => {
            senders.push(sender.json);
          });
        });

        res.end(JSON.stringify(senders), 'application/json');
      }
    })
    .use('/x-nmos/node/v1.3/devices', (req, res, next) => {
      const device_id = req.url.substr(1);

      if (device_id.length)
      {
        const device = this.devices.get(device_id);

        if (device)
        {
          res.end(JSON.stringify(device.json), 'application/json');
        }
        else
        {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found.');
        }

      }
      else
      {
        const devices = Array.from(this.devices.values()).map((dev) => dev.json);

        res.end(JSON.stringify(devices), 'application/json');
      }
    })
    .use('/_manifest', (req, res, next) => {
      const path = req.url.substr(1);

      if (path.length)
      {
        let found = false;

        const sender_id = path.split('.')[0];
        this.devices.forEach((device) => {
          const sender = device.getSender(sender_id);

          if (!sender) return;

          const manifest = sender.getManifest();

          if (!manifest) return;

          res.setHeader('Content-Type', manifest[0]);
          res.end(manifest[1]);
          found = true;
        });

        if (found) return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found.');
    })
    .use('/x-nmos/node/v1.3/', (req, res, next) => {
      if (req.url === '/')
      {
        const paths = [
          'self/',
          'devices/',
          'senders/'
        ];
        res.end(JSON.stringify(paths), 'application/json');
      }
    });

    this.http = http.createServer(app).listen(http_port, ip);

    this.cleanup.add(this.resolver.forEachAsync((api, url) => {
      this.cleanup.add(this.startRegistration(api));
    }));
  }

  registerSelf(api)
  {
    return api.registerNode(this.json);
  }

  unregisterSelf(api)
  {
    return api.deleteNode(this.json);
  }

  startChildRegistration(api)
  {
    const cleanup = new Cleanup();

    let interval_id = setInterval(() => api.updateNodeHealth(this.id), 5000);

    cleanup.add(() => {
      clearInterval(interval_id);
    });
    cleanup.add(this.devices.startRegistration(api));

    return cleanup;
  }

  createDevice(info)
  {
    info = Object.assign({}, info, {
      node_id: this.id,
    });
    return this.devices.create(info);
  }

  makeDevice(info)
  {
    info = Object.assign({}, info, {
      node_id: this.id,
    });
    return this.devices.make(info);
  }

  close()
  {
    this.resolver.close();
    this.http.close();
    this.advertisement.close();
    this.cleanup.close();
  }

  baseUrl()
  {
    const addr = this.http.address();

    return util.format('http://%s:%d', addr.address, addr.port);
  }

  getManifestUrl(id, type)
  {
    return util.format('%s/_manifest/%s.%s', this.baseUrl(), id, type);
  }
}

module.exports = Node;
