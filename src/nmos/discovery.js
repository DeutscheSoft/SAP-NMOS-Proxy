const net = require('net');
const URL = require('url').URL;
const util = require('util');

const dnssd = require('dnssd');
const request = require('request-promise-native');
const request_cb = require('request');

const DynamicSet = require('../dynamic_set.js').DynamicSet;
const Log = require('../logger.js');
const UnionSet = require('../dynamic_set.js').UnionSet;
const PollingSet = require('../dynamic_set.js').PollingSet;

let registration_schemas;

try
{
  const Ajv = require('ajv');
  const fs = require('fs');
  const path = require('path');

  registration_schemas = new Ajv({schemaId: 'id'});

  registration_schemas.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'));

  const schema_directory = path.join(__dirname, "..", "..", "external", "nmos-discovery-registration",
                                     "APIs", "schemas");
  let n = 0;

  fs.readdirSync(schema_directory).forEach((name) => {
    if (!name.endsWith(".json")) return;
    const fname = path.join(schema_directory, name);
    try
    {
      const schema = JSON.parse(fs.readFileSync(fname, { encoding: 'utf8' }));
      registration_schemas.addSchema(schema, name);
      n++;
    }
    catch (err)
    {
      Log.error("Failed to parse schema %o:", fname);
      Log.error(err);
      process.exit(1);
    }
  });

  Log.log("Compiled %d schemas.", n);
}
catch(err)
{
  Log.error("Failed to load nmos schemas", err);
}

async function log_request(options)
{
  Log.log('%s %s', options.method, options.uri);

  try
  {
    const response = await request(options);

    Log.verbose("%s %s result %o", options.method, options.uri, response);
    return response;
  } catch (err) {
    Log.error("%s %s ERROR %d %o", options.method, options.uri, err.statusCode, err.message);
    throw err;
  }
}

/**
 * NMOS v1.2 uses service name nmos-registration which is too long for dnssd. We
 * use this custom service type base class to suppress the error.
 */
function dnssdServiceTypeNoValidate(...args)
{
  dnssd.ServiceType.call(this, ...args);
}
dnssdServiceTypeNoValidate.prototype = Object.assign(Object.create(dnssd.ServiceType.prototype), {
  _validate: function()
  {
    try
    {
      dnssd.ServiceType.prototype._validate.call(this);
    }
    catch (err)
    {
      if (err.toString().search("Service '_nmos-registration' is > 15 bytes") !== -1)
        return;

      throw err;
    }
  }
});


/**
 * Rest APIs.
 */
class RestAPI
{
  constructor(url)
  {
    if (typeof url === 'string')
      url = new URL(url);
    this.url = url;
  }

  resolve(path)
  {
    return new URL(path, this.url);
  }

  get(path)
  {
    return log_request({
      uri: this.resolve(path),
      method: 'GET',
      json: true,
    });
  }

  async post(path, body)
  {
    return log_request({
      uri: this.resolve(path),
      method: 'POST',
      json: true,
      body: body,
    });
  }

  async delete(path)
  {
    return log_request({
      uri: this.resolve(path),
      method: 'DELETE',
    });
  }
}

class RegistrationAPI extends RestAPI
{
  constructor(url, version)
  {
    if (!version) version = 'v1.3';
    super(url + '/x-nmos/registration/' + version + '/');
    this.version = version;
  }

  registerNode(info)
  {
    if (registration_schemas)
    {
      const validator = registration_schemas.getSchema('node.json');

      if (validator)
      {
        if (!validator(info))
        {
          throw new Error("node info does not fit schema.\n");
        }
      }
    }

    return new Promise((resolve, reject) => {
      request_cb.post({
        uri: this.resolve('resource'),
        json: true,
        body: {
          type: 'node',
          data: info,
        },
      }, (error, response, body) => {
        if (error)
        {
          reject(error)
        }
        else if (response.statusCode === 200)
        {
          Log.info('Node exists. Deleting node.');

          this.deleteNode(info).catch((err) => {
            Log.warn('Deleting Node failed. Trying register anyway: %o', err);
          }).then(() => {
            return this.registerNode(info);
          }).then(resolve, reject);
        }
        else if (response.statusCode === 201)
        {
          resolve(body);
        }
        else
        {
          reject(new Error('Failed with status' + response.statusCode));
        }
      });
    });
  }

  updateNode(info)
  {
    if (registration_schemas)
    {
      const validator = registration_schemas.getSchema('node.json');

      if (validator)
      {
        if (!validator(info))
        {
          throw new Error("node info does not fit schema.\n");
        }
      }
    }

    return this.post('resource', {
      type: 'node',
      data: info,
    });
  }

  deleteNode(info)
  {
    return this.delete('resource/nodes/' + info.id);
  }

  updateNodeHealth(node_id)
  {
    return this.post('health/nodes/' + node_id);
  }

  registerDevice(info)
  {
    if (registration_schemas)
    {
      const validator = registration_schemas.getSchema('device.json');

      if (validator)
      {
        if (!validator(info))
        {
          throw new Error("device info does not fit schema.\n");
        }
      }
    }

    return this.post('resource', {
      type: 'device',
      data: info,
    });
  }

  deleteDevice(info)
  {
    return this.delete('resource/devices/' + info.id);
  }

  /**
   * @param info.id - Unique id of this resource.
   * @param info.version - String formatted as <seconds>:<nanoseconds> when this
   *                       resource last changed.
   * @param info.label - Freeform string label.
   * @param info.description - Description of this sender.
   * @param info.tags - Array of tags.
   * @param info.flow_id - UUID uniquely describing the flow (e.g. hash of sdp
   *                       global unique tuple.
   * @param info.transport - Transport type used.
   * @param info.device_id - device id of this flow.
   * @param info.manifest_href - url to the manifest file (e.g. SDP).
   * @param info.interface_binding - 
   */
  registerSender(info)
  {
    if (registration_schemas)
    {
      const validator = registration_schemas.getSchema('sender.json');

      if (validator)
      {
        if (!validator(info))
        {
          throw new Error("Sender info does not fit schema.\n");
        }
      }
    }

    return this.post('resource', {
      type: 'sender',
      data: info,
    });
  }

  deleteSender(info)
  {
    return this.delete('resource/senders/' + info.id);
  }

  registerSource(info)
  {
    if (registration_schemas)
    {
      const validator = registration_schemas.getSchema('source.json');

      if (validator)
      {
        if (!validator(info))
        {
          throw new Error("Sender info does not fit schema.\n");
        }
      }
    }

    return this.post('resource', {
      type: 'source',
      data: info,
    });
  }

  deleteSource(info)
  {
    return this.delete('resource/sources/' + info.id);
  }

  registerFlow(info)
  {
    if (registration_schemas)
    {
      const validator = registration_schemas.getSchema('flow.json');

      if (validator)
      {
        if (!validator(info))
        {
          Log.error('validation failure for flow.json.');
        }
      }
    }

    return this.post('resource', {
      type: 'flow',
      data: info,
    });
  }

  deleteFlow(info)
  {
    return this.delete('resource/flows/' + info.id);
  }

  registerReceiver(info)
  {
    return this.post('resource', {
      type: 'receiver',
      data: info,
    });
  }
}

/**
 * Resource classes
 */
class Resource
{
  get json()
  {
    return this.info;
  }

  constructor(info, api)
  {
    this.info = info;
    this.api = api;
  }

  get id()
  {
    return this.info.id;
  }
}

class Sender extends Resource
{
  fetchManifest()
  {
    return request({
      method: 'GET',
      uri: new URL(this.info.manifest_href),
    });
  }
}

class Device extends Resource
{
}

class Receiver extends Resource
{
}

class Node extends Resource
{
}

/**
 * Resource lists.
 */
class ResourceSet extends PollingSet
{
  create(info)
  {
    return new Resource(info, this.api);
  }
}

class Nodes extends ResourceSet
{
  fetchList()
  {
    return this.api.fetchNodes();
  }

  create(info)
  {
    return new Node(info, this.api);
  }
}

class Senders extends ResourceSet
{
  fetchList()
  {
    return this.api.fetchSenders();
  }

  create(info)
  {
    return new Sender(info, this.api);
  }
}

class Devices extends ResourceSet
{
  fetchList()
  {
    return this.api.fetchDevices();
  }

  create(info)
  {
    return new Device(info, this.api);
  }
}

class Receivers extends ResourceSet
{
  fetchList()
  {
    return this.api.fetchReceivers();
  }

  create(info)
  {
    return new Receiver(info, this.api);
  }
}

// Base class used by both query and node api (which are almost identical).
class QueryAPIBase extends RestAPI
{
  fetchSender(id)
  {
    return this.get('senders/'+id);
  }

  fetchSenders()
  {
    return this.get('senders');
  }

  fetchReceivers()
  {
    return this.get('receivers');
  }

  fetchDevices()
  {
    return this.get('devices');
  }

  fetchDevice(id)
  {
    return this.get('devices/'+id);
  }

  senders(interval)
  {
    return new Senders(this, interval);
  }

  receivers(interval)
  {
    return new Receivers(this, interval);
  }

  devices(interval)
  {
    return new Devices(this, interval);
  }
}

class QueryAPI extends QueryAPIBase
{
  constructor(url, version)
  {
    if (!version) version = 'v1.3';
    super(url + '/x-nmos/query/' + version + '/');
    this.version = version;
  }

  fetchNodes()
  {
    return this.get('nodes');
  }

  nodes(interval)
  {
    return new Nodes(this, interval);
  }
}

class NodeAPI extends QueryAPIBase
{
  constructor(url)
  {
    super(url + '/x-nmos/node/v1.3/');
  }

  fetchSelf()
  {
    return this.get('self');
  }
}

function url_and_version_from_service(info, filter)
{
  const port = info.port;
  const host = info.addresses.filter((ip) => net.isIPv4(ip) && filter(ip))[0];
  const proto = info.txt.api_proto;

  const versions = info.txt.api_ver.split(',');
  let version;

  for (let v of [ 'v1.3', 'v1.2', 'v1.1' ])
  {
    if (versions.includes(v))
    {
      version = v;
      break;
    }
  }

  if (!version)
  {
    throw new Error(util.format('Does not support NMOS API version v1.3, v1.2 or v1.1: %o', info));
  }

  return [ util.format('%s://%s:%d', proto, host, port), version ];
}

function ip_mask(ip, netmask)
{
  if (typeof(ip) === 'string')
  {
    ip = ip.split('.').map((v) => parseInt(v));
  }

  if (typeof(netmask) === 'string')
  {
    netmask = netmask.split('.').map((v) => parseInt(v));
  }

  return ip.map((v, i) => v & netmask[i]).join('.');
}

class Resolver extends DynamicSet
{
  get apis()
  {
    return this.entries;
  }

  isLocalIP(ip)
  {
    if (!this.interface) return true;

    if (this.netmask === null)
    {
      const interfaces = require('os').networkInterfaces();

      for (let ifname in interfaces)
      {
        const addresses = interfaces[ifname];

        for (let i = 0; i < addresses.length; i++)
        {
          if (addresses[i].address === this.interface)
          {
            this.netmask = addresses[i].netmask;
          }
        }
      }

      if (this.netmask === null)
      {
        Log.error('Could not find netmask for ip %o', this.interface);
        return;
      }

      this.netmask = this.netmask.split('.').map((v) => parseInt(v));
    }

    return ip_mask(this.interface, this.netmask) === ip_mask(ip, this.netmask);
  }

  isLocalService(info)
  {
    if (!this.interface) return true;

    const service_ips = info.addresses.filter((addr) => net.isIPv4(addr));

    for (let i = 0; i < service_ips.length; i++)
    {
      if (this.isLocalIP(service_ips[i])) return true;
    }

    return false;
  }

  constructor(options, api_class, ...dnssd_types)
  {
    super();
    this.interface = options ? options.interface : null;
    this.netmask = null;
    this.browsers = [];

    for (let dnssd_type of dnssd_types)
    {
      const service_type = dnssd_type.length >= 16
          ? new dnssdServiceTypeNoValidate(dnssd_type, '_tcp')
          : new dnssd.ServiceType(dnssd_type, '_tcp');
      const browser = new dnssd.Browser(service_type, options);

      const add_or_update = (info) => {
        try
        {
          if (!this.isLocalService(info)) return;

          const id = info.name;

          if (this.has(id)) return;

          const [ url, version ] = url_and_version_from_service(info, (ip) => this.isLocalIP(ip));

          if (!(url.startsWith('http:') || url.startsWith('https'))) return;

          const api = new api_class(url, version);

          this.add(id, api);
        }
        catch (error)
        {
          Log.warn('Could not determine URL for NMOS service: ', error);
        }
      };

      browser.on('serviceUp', add_or_update);
      browser.on('serviceChanged', add_or_update);
      browser.on('serviceDown', (info) => {
        try
        {
          const id = info.name;

          if (this.has(id))
          {
            this.delete(id);
          }
        }
        catch (error)
        {
          Log.warn('Could not determine URL for NMOS service: ', error);
        }
      });
      browser.start();
      this.browsers.push(browser);
    }
  }

  close()
  {
    super.close();

    for (let browser of this.browsers)
    {
      browser.stop();
    }
  }
}

class QueryResolver extends Resolver
{
  constructor(options)
  {
    super(options, QueryAPI, 'nmos-query');
  }
}

class RegistryResolver extends Resolver
{
  constructor(options)
  {
    super(options, RegistrationAPI, 'nmos-register', 'nmos-registration');
  }
}

class NodeResolver extends Resolver
{
  constructor(options)
  {
    super(options, NodeAPI, 'nmos-node');
  }
}

function QueryAndNodeResolver(options)
{
  const queries = new QueryResolver(options);
  const nodes = new NodeResolver(options);

  const queries_and_nodes = queries.union(nodes);

  queries_and_nodes.on('close', () => {
    queries.close();
    nodes.close();
  });

  return queries_and_nodes;
}

function AllSenders(options)
{
  const senders = new UnionSet();
  const queries_and_nodes = QueryAndNodeResolver(options);

  const cleanup = queries_and_nodes.forEachAsync((api, id, set) => {
    let _senders;

    const start = () => {
      api = set.get(id);
      _senders = api.senders();
      senders.addSet(_senders);
    };
    const stop = () => {
      senders.removeSet(_senders);
      _senders.close();
      _senders = null;
      api = null;
    };

    set.waitForUpdate(id).then(() => {
      stop();
      start();
    }, () => {});
    start();
    return stop;
  });

  senders.on('close', () => {
    cleanup.close();
    queries_and_nodes.close();
  });

  return senders;
}

module.exports = {
  QueryResolver: QueryResolver,
  RegistryResolver: RegistryResolver,
  NodeResolver: NodeResolver,
  QueryAndNodeResolver: QueryAndNodeResolver,
  AllSenders: AllSenders,
  ResourceSet: ResourceSet,
};
