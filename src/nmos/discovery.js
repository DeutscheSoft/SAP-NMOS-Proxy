const net = require('net');
const URL = require('url').URL;
const util = require('util');

const dnssd = require('dnssd');
const request = require('request-promise-native');

const DynamicSet = require('../dynamic_set.js').DynamicSet;
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
      console.error("Failed to parse schema %o:", fname);
      console.error(err);
      process.exit(1);
    }
  });

  //console.log("Compiled %d schemas.", n);
}
catch(err)
{
  console.error("Failed to load nmos schemas", err);
}

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

  async get(path)
  {
    const response = await request({
      uri: this.resolve(path),
      method: 'GET'
    });

    return JSON.parse(response);
  }

  async post(path, body)
  {
    const response = await request({
      uri: this.resolve(path),
      method: 'POST',
      json: true,
      body: body,
    });

    //console.log("RESPONSE: %o", response);
    return response;
  }

  async delete(path)
  {
    return await request({
      uri: this.resolve(path),
      method: 'DELETE',
    });
  }
}

class RegistrationAPI extends RestAPI
{
  constructor(url)
  {
    super(url + '/x-nmos/registration/v1.3/');
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
    return this.post('health/nodes/' + node_id, {});
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

  constructor(info)
  {
    this.info = info;
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
    return new Resource(info);
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
    return new Node(info);
  }
}

class Senders extends ResourceSet
{
  async fetchList()
  {
    return this.api.fetchSenders();
  }

  create(info)
  {
    return new Sender(info);
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
    return new Device(info);
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
    return new Receiver(info);
  }
}

// Base class used by both query and node api (which are almost identical).
class QueryAPIBase extends RestAPI
{
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
  constructor(url)
  {
    super(url + '/x-nmos/query/v1.3/');
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

function url_from_service(info, filter)
{
  const port = info.port;
  const host = info.addresses.filter((ip) => net.isIPv4(ip) && filter(ip))[0];
  const proto = info.txt.api_proto;

  if (-1 === info.txt.api_ver.split(',').indexOf('v1.3'))
  {
    throw new Error('Does not support NMOS API version v1.3');
  }

  return util.format('%s://%s:%d', proto, host, port);
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
        console.error('Could not find netmask for ip %o', this.interface);
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

  constructor(options, api_class, dnssd_type)
  {
    super();
    this.interface = options ? options.interface : null;
    this.netmask = null;
    this.browser = new dnssd.Browser(dnssd.tcp(dnssd_type), options);

    this.browser.on('serviceUp', (info) => {
      try
      {
        if (!this.isLocalService(info)) return;

        const url = url_from_service(info, (ip) => this.isLocalIP(ip));
        const api = new api_class(url);
        const id = info.fullname;

        this.add(id, api);
      }
      catch (error)
      {
        console.warn('Could not determine URL for NMOS service: ', error);
      }
    });
    this.browser.on('serviceDown', (info) => {
      try
      {
        const url = url_from_service(info);
        const id = info.fullname;

        if (this.has(id))
        {
          this.delete(id);
        }
      }
      catch (error)
      {
        console.warn('Could not determine URL for NMOS service: ', error);
      }
    });
    this.browser.start();
  }

  close()
  {
    super.close();
    this.browser.stop();
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
    super(options, RegistrationAPI, 'nmos-register');
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
