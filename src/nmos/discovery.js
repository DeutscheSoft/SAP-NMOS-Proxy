const net = require('net');
const URL = require('url').URL;
const util = require('util');

const dnssd = require('dnssd');
const request = require('request-promise-native');

const DynamicSet = require('../dynamic_set.js');

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

class Senders extends DynamicSet
{
  constructor(query_api, poll_interval)
  {
    super();
    this.api = query_api;
    this.poll_interval = poll_interval || 5000;
    this.poll_id = undefined;
    this.fetch();
  }

  async fetch()
  {
    this.poll_id = undefined;
    
    try
    {
      const senders = await this.api.fetchSenders();

      if (this.closed) return;

      senders.forEach((sender) => {
        const id = sender.id;

        const prev = this.get(id);

        if (prev)
        {
          if (prev.version !== sender.version)
            this.update(id, sender);
        }
        else
        {
          this.add(id, sender);
        }
      });
    }
    catch (err)
    {
      if (this.closed) return;

      console.error('fetching senders failed:', err);
    }

    this.poll_id = setTimeout(() => this.fetch(), this.poll_interval);
  }

  close()
  {
    super.close();
    if (this.poll_id !== undefined)
      clearTimeout(this.poll_id);
  }
}

class QueryAPI extends RestAPI
{
  constructor(url)
  {
    super(url + '/x-nmos/query/v1.3/');
  }

  fetchNodes()
  {
    return this.get('nodes');
  }

  fetchSenders()
  {
    return this.get('senders');
  }

  fetchReceivers()
  {
    return this.get('receivers');
  }

  senders(poll_interval)
  {
    return new Senders(this, poll_interval);
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

    this.browser = new dnssd.Browser(dnssd.tcp('nmos-query'), options);

    this.browser.on('serviceUp', (info) => {
      try
      {
        const url = url_from_service(info);
        const api = new api_class(url);

        this.add(url, api);
      }
      catch (error)
      {
        console.warn('Could not determine URL for NMOS service: ', error);
      }
    });
    this.browser.on('serviceDown', (info) => {
      try
      {
        if (this.has(url))
        {
          this.delete(url);
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

module.exports = {
  QueryResolver: QueryResolver,
  RegistryResolver: RegistryResolver,
};
