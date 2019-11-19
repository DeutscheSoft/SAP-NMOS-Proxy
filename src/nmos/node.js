const assert = require('assert');
const Events = require('events');
const util = require('util');
const http = require('http');

const connect = require('connect');
const dnssd = require('dnssd');

const Cleanup = require('../event_helpers.js').Cleanup;
const Log = require('../logger.js');
const DynamicSet = require('../dynamic_set.js').DynamicSet;
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
    this.refcount = 1;
  }

  ref()
  {
    this.refcount++;
    return this;
  }

  unref()
  {
    this.refcount--;

    if (!this.refcount)
    {
      this.close();
    }
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
        await this.unregisterSelf(api);
      } catch (err) {
        if (err.statusCode === 404)
        {
          // was not registered, yet.
          return;
        }
        Log.error('Failed to remove device: %o', this.id);
      }
    });

    let updating = false;
    let again = false;
    let created = false;

    const do_update = async () => {
      if (cleanup.closed) return;
      try
      {
        if (updating)
        {
          again = true;
          Log.verbose('Waiting for previous update to complete in %s', this);
          return;
        }
        updating = true;
        await retry(() => this.registerSelf(api), 3, 1000);
        Log.info('Updated %s in NMOS registry', this);

        if (!created)
        {
          created = true;
          // start registering children.
          const child_task = this.startChildRegistration(api);

          cleanup.add(() => cleanup.close());
          cleanup.add(child_task);
        }
      }
      catch (err)
      {
        Log.error('Update of %o failed.', this.info);
        cleanup.close();
        return;
      }
      updating = false;
      if (again)
      {
        Log.verbose('doing update again one more time.');
        again = false;
        do_update();
      }
    };

    do_update();
    cleanup.subscribe(this, 'update', do_update);

    return cleanup;
  }

  toString()
  {
    return util.format('%s(%o)', this.constructor.name, this.id);
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

    return resource.ref();
  }

  startRegistration(api)
  {
    return this.forEachAsync((entry, id) => {
      return entry.startRegistration(api);
    });
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
    return api.deleteSender(this.info);
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

  update(info)
  {
    const sdp = info.sdp;
    if (!(sdp instanceof SDP))
      throw new TypeError('Expected type SDP in field \'sdp\'.');
    delete info.sdp;
    this.sdp = sdp;
    super.update(info);
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
    return this.info;
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
    // NOTE: we use 'info' here on purpose and not this.json,
    // because the senders which we might already know about
    // may be unknown to the registry.
    const json = Object.assign(
      {},
      this.info,
      {
        senders: [],
        receivers: []
      }
    );
    return api.registerDevice(json);
  }

  unregisterSelf(api)
  {
    return api.deleteDevice(this.info);
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
    const http_port = options.http_port;

    const info = Object.assign({
      version: util.format('%d:%d', Date.now(), 0),
      label: '',
      description: '',
      tags: {},
      caps: {},
      api: {
        "versions": [ "v1.3" ],
        "endpoints": [ ],
      },
      services: [],
      clocks: [],
      interfaces: [],
    }, options.info||{});

    const dnssd_options = Object.assign({
      interface: ip,
    }, options.dnssd || {});

    super(null, info);

    this.cleanup = new Cleanup();
    this.devices = new Devices(this);

    const send_json = (res, data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    };

    const json = (cb) => {
      return (req, res, next) => {
        send_json(res, cb(req, res, next));
      };
    };

    const exact = (cb) => {
      return (req, res, next) => {
        if (req.url.length > 1)
        {
          next();
        }
        else
        {
          cb(req, res, next);
        }
      };
    };

    const app = connect()
    .use((req, res, next) => {
      // we do not use post, delete or put.
      // also, having cors active by default like so is a terrible default
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, HEAD, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
      res.setHeader('Access-Control-Max-Age', '3600');
      next();
    })
    .use('/x-nmos/node/v1.3/flows', exact(json((req, res, next) => {
      return [];
    })))
    .use('/x-nmos/node/v1.3/receivers', exact(json((req, res, next) => {
      return [];
    })))
    .use('/x-nmos/node/v1.3/sources', exact(json((req, res, next) => {
      return [];
    })))
    .use('/x-nmos/node/v1.3/self', exact(json((req, res, next) => {
      return this.info;
    })))
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
          send_json(res, sender.json);
        });

        if (!found)
        {
          next();
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

        send_json(res, senders);
      }
    })
    .use('/x-nmos/node/v1.3/devices', (req, res, next) => {
      const device_id = req.url.substr(1);

      if (device_id.length)
      {
        const device = this.devices.get(device_id);

        if (device)
        {
          send_json(res, device.json);
        }
        else
        {
          next();
        }
      }
      else
      {
        const devices = Array.from(this.devices.values()).map((dev) => dev.json);

        send_json(res, devices);
      }
    })
    .use('/_manifest', (req, res, next) => {
      const path = req.url.substr(1);
      Log.info('Request for Manifest %o', path);

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
          Log.info('Manifest: %o', manifest);
          found = true;
        });

        if (found) return;
      }

      Log.info('Manifest %o not found.', path);
      next();
    })
    .use('/x-nmos/node/v1.3/', exact(json(() => {
      return [
        'self/',
        'devices/',
        'senders/'
      ];
    })))
    .use('/x-nmos/node', exact(json(() => {
      return [ 'v1.3/' ];
    })))
    .use('/x-nmos', exact(json(() => {
      return [ 'node/' ];
    })))
    .use((req, res, next) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 404, error: 'Not found!', debug: null }));
    });

    this.http = http.createServer(app);
    this.http.listen({
        port: http_port,
        host: ip,
        exclusive: true,
      },
      () => {
        const port = this.http.address().port;
        Log.info('http server running at http://%s:%d', ip, port);
        this.advertisement = new dnssd.Advertisement(dnssd.tcp('nmos-node'), port, {
          txt: {
            api_ver: 'v1.3',
            api_proto: 'http',
          },
        });
        info.api.endpoints = info.api.endpoints.concat([{
          "host": ip,
          "port": port,
          "protocol": "http",
        }]);
        info.href = util.format('http://%s:%d/', ip, port);
        this.update(info);
        this.resolver = new RegistryResolver(dnssd_options);
        this.cleanup.add(this.resolver.forEachAsync((api, url) => {
          Log.info('Found NMOS registry at %o', url);
          return this.startRegistration(api);
        }));
        this.advertisement.start();
    });

    this.resolver = null;
    this.advertisement = null;
  }

  registerSelf(api)
  {
    return api.registerNode(this.json);
  }

  unregisterSelf(api)
  {
    return api.deleteNode(this.info);
  }

  startChildRegistration(api)
  {
    const cleanup = new Cleanup();

    let interval_id = setInterval(async () => {
      try
      {
        await api.updateNodeHealth(this.id);
      }
      catch (err)
      {
        Log.error('Node health heartbeat failed. Giving up on registry.');
        cleanup.close();
      }
    }, 5000);

    cleanup.add(() => clearInterval(interval_id));
    cleanup.add(this.devices.startRegistration(api));

    return cleanup;
  }

  getDevice(id)
  {
    return this.devices.get(id);
  }

  hasDevice(id)
  {
    return this.devices.has(id);
  }

  getSender(id)
  {
    let sender = null;
    this.devices.forEach((device) => {
        if (sender) return;
        const _sender = device.getSender(id);
        if (_sender) sender = _sender;
    });
    return sender;
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
    if (this.resolver)
      this.resolver.close();
    this.http.close();
    if (this.advertisement)
      this.advertisement.stop();
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
