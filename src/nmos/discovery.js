const net = require('net');
const URL = require('url').URL;
const util = require('util');

const dnssd = require('dnssd');
const request = require('request-promise-native');

const DynamicSet = require('../dynamic_set.js').DynamicSet;

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

  console.log("Compiled %d schemas.", n);
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

    console.log("RESPONSE: %o", response);
    return response;
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
class ResourceSet extends DynamicSet
{
  constructor(api, interval)
  {
    super();
    this.api = api;
    this.interval = interval || 5000;
    this.poll_id = undefined;
    this.fetch();
  }

  create(info)
  {
    return new Resource(info);
  }

  async fetch()
  {
    this.poll_id = undefined;
    
    try
    {
      const entries = await this.fetchList();
      const found = new Set();

      if (this.closed) return;

      entries.forEach((info) => {
        const id = info.id;

        found.add(id);

        const prev = this.get(id);

        if (prev)
        {
          if (prev.version !== info.version)
            this.update(id, this.create(info));
        }
        else
        {
          this.add(id, this.create(info));
        }
      });

      this.forEach((entry, id) => {
        if (!found.has(id))
          this.delete(id);
      });
    }
    catch (err)
    {
      if (this.closed) return;

      console.error('fetching entries failed:', err);
    }

    this.poll_id = setTimeout(() => this.fetch(), this.interval);
  }

  close()
  {
    super.close();
    if (this.poll_id !== undefined)
      clearTimeout(this.poll_id);
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
  fetchList()
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

function url_from_service(info)
{
  const port = info.port;
  const host = info.addresses.filter((ip) => net.isIPv4(ip))[0];
  const proto = info.txt.api_proto;

  if (-1 === info.txt.api_ver.split(',').indexOf('v1.3'))
  {
    throw new Error('Does not support NMOS API version v1.3');
  }

  return util.format('%s://%s:%d', proto, host, port);
}

class Resolver extends DynamicSet
{
  get apis()
  {
    return this.entries;
  }

  constructor(options, api_class, dnssd_type)
  {
    super();

    this.browser = new dnssd.Browser(dnssd.tcp(dnssd_type), options);

    this.browser.on('serviceUp', (info) => {
      try
      {
        const url = url_from_service(info);
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

module.exports = {
  QueryResolver: QueryResolver,
  RegistryResolver: RegistryResolver,
  NodeResolver: NodeResolver,
};
