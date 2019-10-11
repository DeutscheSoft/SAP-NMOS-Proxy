const Events = require('events');
const net = require('net');
const util = require('util');
const URL = require('url').URL;
const DynamicSet = require('./dynamic_set.js');

const Cleanup = require('./event_helpers.js').Cleanup;

const dnssd = require('dnssd');
const request = require('request-promise-native');

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
      json: true
    }); 

    return JSON.parse(response);
  }
}

class RegistrationAPI extends RestAPI
{
  constructor(url)
  {
    super(url + '/x-nmos/registration/v1.3/');
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
  register_sender(info)
  {
    return this.post('resource', {
      type: 'sender',
      data: body,
    });
  }

  register_receiver(info)
  {
    return this.post('resource', {
      type: 'receiver',
      data: body,
    });
  }
}

class QueryAPI extends RestAPI
{
  constructor(url)
  {
    super(url + '/x-nmos/query/v1.3/');
  }

  nodes()
  {
    return this.get('nodes');
  }

  senders()
  {
    return this.get('senders');
  }

  receivers()
  {
    return this.get('receivers');
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
