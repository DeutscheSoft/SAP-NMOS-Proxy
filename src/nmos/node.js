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

class Datum extends Events
{
  constructor(parent, info)
  {
    super();
    this.parent = parent;
    this.info = Object.assign({}, info);
    this.refcount = 1;
  }

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

  json(api)
  {
    return this.info;
  }

  get id()
  {
    throw new Error('Missing implementation of get id');
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
    const n = Object.assign({}, this.info, info);
    if (deep_equal(n, this.info))
      return;
    this.info = n;
    this.emit('update');
  }

  close()
  {
    this.emit('close');
    this.removeAllListeners();
  }

  toString()
  {
    return util.format('%s(%o)', this.constructor.name, this.id);
  }
}

class Resource extends Datum
{
  get id()
  {
    return this.info.id;
  }

  constructor(parent, info)
  {
    super(parent, info);
    this.registered = new Set(); // list of urls
  }

  update(info)
  {
    if (info.id && info.id !== this.id)
      throw new Error('ID cannot be changed.');

    return super.update(info);
  }

  is_registered_at(url)
  {
    return this.registered.has(url);
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
        this.registered.add(api.url);
        this.emit('registered');

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

class Clock extends Datum
{
  get id()
  {
    return this.info.name;
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
    return api.registerSender(this.json(api));
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

class Flow extends Resource
{
  get source()
  {
    return this.parent;
  }

  get device()
  {
    return this.source.device;
  }

  constructor(...args)
  {
    super(...args);
    this.senders = new Senders(this);
  }

  getSender(id)
  {
    return this.senders.get(id);
  }

  allSenders()
  {
    return Array.from(this.senders.values());
  }

  makeSender(info)
  {
    info = Object.assign({}, info, {
      device_id: this.device.id,
      flow_id: this.id,
    });
    const sender = this.senders.make(info);

    sender.on('registered', () => this.device.emit('update'));

    return sender;
  }

  makeRTPSender(info)
  {
    info = Object.assign({}, info, {
      device_id: this.device.id,
      flow_id: this.id,
    });
    return this.senders.make(info, RTPSender);
  }

  registerSelf(api)
  {
    return api.registerFlow(this.json(api));
  }

  unregisterSelf(api)
  {
    return api.deleteFlow(this.info);
  }

  startChildRegistration(api)
  {
    return this.senders.startRegistration(api);
  }
}

class Flows extends ResourceSet
{
  constructor(device)
  {
    super(Flow, device);
  }
}

class Source extends Resource
{
  get device()
  {
    return this.parent;
  }

  registerSelf(api)
  {
    return api.registerSource(this.json(api));
  }

  unregisterSelf(api)
  {
    return api.deleteSource(this.info);
  }

  constructor(...args)
  {
    super(...args);
    this.flows = new Flows(this);
  }

  startChildRegistration(api)
  {
    return this.flows.startRegistration(api);
  }

  makeFlow(info)
  {
    info = Object.assign({}, info, {
      device_id: this.device.id,
      source_id: this.id,
    });
    return this.flows.make(info);
  }

  getFlow(id)
  {
    return this.flows.get(id);
  }

  getSender(id)
  {
    let sender;

    this.flows.forEach((flow) => {
      if (sender) return;
      sender = flow.getSender(id);
    });

    return sender;
  }

  allSenders()
  {
    let senders = [];

    this.flows.forEach((flow) => {
      senders = senders.concat(flow.allSenders());
    });

    return senders;
  }
}

class RTPSender extends Sender
{
  json(api)
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

class Sources extends ResourceSet
{
  constructor(device)
  {
    super(Source, device);
  }
}

class Device extends Resource
{
  json(api)
  {
    // NOTE: we do not use the real senders here on purpose,
    // because the senders which we might already know about
    // may be unknown to the registry.
    const senders = this.allSenders()
      .filter((sender) => !api || sender.is_registered_at(api.url))
      .map((sender) => sender.id);

    return Object.assign(
      {},
      this.info,
      {
        senders: senders,
        receivers: []
      }
    );
  }

  get node()
  {
    return this.parent;
  }

  constructor(node, info)
  {
    super(node, info);
    this.sources = new Sources(this);
  }

  getSource(id)
  {
    return this.sources.get(id);
  }

  getFlow(id)
  {
    let flow = null;

    this.sources.forEach((source, _id) => {
      if (flow) return;
      flow = source.getFlow(id);
    });

    return flow;
  }

  getSender(id)
  {
    let sender = null;

    this.sources.forEach((source, _id) => {
      if (sender) return;
      sender = source.getSender(id);
    });

    return sender;
  }

  registerSelf(api)
  {
    return api.registerDevice(this.json(api));
  }

  unregisterSelf(api)
  {
    return api.deleteDevice(this.info);
  }

  startChildRegistration(api)
  {
    return this.sources.startRegistration(api);
  }

  makeSource(info)
  {
    info = Object.assign({}, info, {
      device_id: this.id,
    });
    return this.sources.make(info);
  }

  allSenders()
  {
    let senders = [];

    this.sources.forEach((source) => {
      senders = senders.concat(source.allSenders());
    });

    return senders;
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
  json(api)
  {
    return Object.assign({}, this.info, {
      clocks: Array.from(this.clocks.values()).map((clock) => clock.json(api)),
    });
  }

  constructor(options)
  {
    const ip = options.ip || get_first_public_ip();
    const http_port = options.http_port;

    const versions = [ 'v1.3', 'v1.2' ];

    const info = Object.assign({
      version: util.format('%d:%d', Date.now(), 0),
      label: '',
      description: '',
      tags: {},
      caps: {},
      api: {
        "versions": versions,
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
    this.clocks = new Map();

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
    });

    for (let version of versions)
    {
      app
      .use('/x-nmos/node/'+version+'/flows', (req, res, next) => {
        const flow_id = req.url.substr(1);

        if (flow_id.length)
        {
          let found = false;

          this.devices.forEach((device) => {
            if (found) return;
            const flow = device.getFlow(flow_id);

            if (!flow) return;

            found = true;
            send_json(res, flow.json());
          });

          if (!found)
          {
            next();
          }
        }
        else
        {
          const flows = [];

          this.devices.forEach((device) => {
            device.sources.forEach((source, id) => {
              source.flows.forEach((flow, id) => {
                flows.push(flow.json());
              });
            });
          });

          send_json(res, flows);
        }
      })
      .use('/x-nmos/node/'+version+'/receivers', exact(json((req, res, next) => {
        return [];
      })))
      .use('/x-nmos/node/'+version+'/sources', (req, res, next) => {
        const source_id = req.url.substr(1);

        if (source_id.length)
        {
          let found = false;

          this.devices.forEach((device) => {
            if (found) return;
            const source = device.getSource(source_id);

            if (!source) return;

            found = true;
            send_json(res, source.json());
          });

          if (!found)
          {
            next();
          }
        }
        else
        {
          const sources = [];

          this.devices.forEach((device) => {
            device.sources.forEach((source, id) => {
              sources.push(source.json());
            });
          });

          send_json(res, sources);
        }
      })
      .use('/x-nmos/node/'+version+'/self', exact(json((req, res, next) => {
        return this.json();
      })))
      .use('/x-nmos/node/'+version+'/senders', (req, res, next) => {
        const sender_id = req.url.substr(1);

        if (sender_id.length)
        {
          let found = false;

          this.devices.forEach((device) => {
            if (found) return;
            const sender = device.getSender(sender_id);

            if (!sender) return;

            found = true;
            send_json(res, sender.json());
          });

          if (!found)
          {
            next();
          }
        }
        else
        {
          let senders = [];

          this.devices.forEach((device) => {
            senders = senders.concat(device.allSenders().map((sender) => sender.json()));
          });

          send_json(res, senders);
        }
      })
      .use('/x-nmos/node/'+version+'/devices', (req, res, next) => {
        const device_id = req.url.substr(1);

        if (device_id.length)
        {
          const device = this.devices.get(device_id);

          if (device)
          {
            send_json(res, device.json());
          }
          else
          {
            next();
          }
        }
        else
        {
          const devices = Array.from(this.devices.values()).map((dev) => dev.json());

          send_json(res, devices);
        }
      })
      .use('/x-nmos/node/'+version+'/', exact(json(() => {
        return [
          'self/',
          'devices/',
          'senders/',
          'sources/',
          'flows/',
          'receivers/'
        ];
      })));
    }

    app
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
    .use('/x-nmos/node', exact(json(() => {
      return versions.map((v) => v + '/');
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
            api_ver: versions.join(','),
            api_proto: 'http',
          },
          interface: ip,
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
        this.emit('ready');
    });

    this.resolver = null;
    this.advertisement = null;
  }

  registerSelf(api)
  {
    return api.registerNode(this.json(api));
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
        sender = device.getSender(id);
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

  createClock(info)
  {
    let name, i = 0;

    do
    {
      name = 'clk' + i;
    } while (this.clocks.has(name));

    info = Object.assign({}, info, { name: name });

    const clock = new Clock(this, info);

    this.clocks.set(name, clock);

    clock.on('close', () => {
      this.clocks.delete(name);
      this.emit('update');
    });
    clock.on('update', () => this.emit('update'));
  }

  findClock(cb)
  {
    let clock;

    this.clocks.forEach((_clock) => {
      if (clock) return;
      if (cb(_clock))
      {
        clock = _clock;
      }
    });

    return clock;
  }

  makeClock(info)
  {
    if (info.ref_type === 'ptp')
    {
      const clock = this.findClock((clock) => {
        return clock.info.ref_type === 'ptp' &&
          clock.info.ref_type.gmid === info.gmid;
      });

      if (clock) return clock.ref();

      return this.createClock(info);
    }
    else if (info.ref_type === 'internal')
    {
      const clock = this.findClock(clock => clock.info.ref_type === 'internal');

      if (clock) return clock.ref();

      return this.createClock(info);
    }
    else throw new Error("Unknown clock type.");
  }
}

module.exports = Node;
