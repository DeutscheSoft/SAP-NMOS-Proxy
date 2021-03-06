const Events = require('events');
const os = require('os');

const util = require('util');
const { Cleanup, delay } = require('./event_helpers.js');
const NMOS = require('./nmos.js');
const Log = require('./logger.js');
const SAP = require('./sap.js');
const SDP = require('./sdp.js');

const uuid = require('uuid/v5');
const lookupMACAddress = require('./mac_lookup.js').lookupMACAddress;

function interface_start_address(interface)
{
  const ip = interface.address.split('.').map((v) => parseInt(v));
  const netmask = interface.netmask.split('.').map((v) => parseInt(v));

  for (let i = 0; i < ip.length; i++)
  {
    ip[i] &= netmask[i];
  }

  return ip.join('.');
}

// The namespace ID of the nmos proxy. We use this as the base of
// all registrations. It will be parametrized using
//  * ip network the proxy is operating on
//  * NMOS resource ids
const PROXY_NAMESPACE = 'd6fe88a0-aac7-4f53-8de3-9046fcc4b766';

class Proxy extends Events
{
  constructor(options)
  {
    super();
    const network_interface = options.interface;

    this.network_interface = network_interface;
    this.cleanup = new Cleanup();

    const ip = network_interface.address;

    Log.info('Starting proxy on interface %s', ip);

    const node_id = uuid('node:'+interface_start_address(network_interface),
                         options.nmos_uuid||PROXY_NAMESPACE);
    console.log(options);
    this.nmosNode = new NMOS.Node({
      ip: ip,
      http_port: options.http_port,
      info: {
        id: node_id,
        label: 'SAP to NMOS proxy',
        description: 'This node proxies between SAP and NMOS.',
      },
    });

    this.nmosNode.on('ready', () => this.emit('ready'));

    this.sapPort = new SAP.Port(ip);
    this.sapAnnouncements = new SAP.Announcements(this.sapPort);
    this.sapAnnounce = new SAP.OwnAnnouncements();
    this.sapAnnouncements.ignoreFrom(this.sapAnnounce);
    this.nmosSenders = NMOS.Discovery.AllSenders({ interface: ip }, (queries_or_nodes) => {
      return queries_or_nodes.filter((id, api) => {

        if (this.nmosNode.info.href.startsWith(api.url.origin))
        {
          console.log('Ignoring own NMOS Node API: %o', api.url.origin);
          return false;
        }

        return true;
      });
      return queries_or_nodes;
    });
    this.nmosSendersWithSDP = this.nmosSenders.asyncFilter(async (sender_id, sender) => {
      let sdp = null;

      if (this.nmosNode.hasDevice(sender.json.device_id))
      {
        Log.log('Sender id %o was generated by us. Ignoring.', sender.id);
        return false;
      }

      return true;
    }).asyncMap(async (sender_id, sender, set, action) => {
      Log.info('Found NMOS sender: %o\n', sender);

      // fetch SDP but only if the entry is not being deleted
      if (action === 'delete')
      {
        return [ sender_id, set.get(sender_id) ];
      }

      let sdp = null;

      try
      {
        sdp = new SDP(await sender.fetchManifest());
      }
      catch (err)
      {
        Log.error("Failed to fetch SDP string from sender %o", sender.id);
      }

      return [ sender_id, [ sender, sdp ] ];
    }).filter((sender_id, entry) => !!entry[1]);

    this.sdpStringsToNMOS = this.sapAnnouncements.union();

    this.cleanup.add(() => {
      this.sdpStringsToNMOS.close();
      this.nmosSenders.close();
      this.sapAnnounce.close();
      this.sapAnnouncements.close();
      this.sapPort.close();
      this.nmosNode.close();
    });

    // NMOS -> SAP
    this.cleanup.add(this.nmosSendersWithSDP.forEachAsync((entry, sender_id, senders) => {
      let closed = false;
      let sdp;

      const task = async () => {
        let created = false;

        do
        {
          const change_p = senders.waitForChange(sender_id);

          const sender = entry[0];
          const _sdp = entry[1];

          try
          {
            if (created)
            {
              this.sapAnnounce.update(_sdp);
            }
            else
            {
              this.sapAnnounce.add(_sdp);
            }
            created = true;
            Log.info('Created SAP announcement for %o', _sdp.id);
            sdp = _sdp;
          }
          catch (err)
          {
            Log.warn('announceing SAP failed:', err);
          }

          try
          {
            entry = await change_p;
            if (closed) return;
          }
          catch (err)
          {
            // end task
            return;
          }
        } while (true);
      };

      // run
      task().catch((err) => { Log.error('sap announcement task failed.', err); });

      return () => {
        closed = true;
        if (sdp)
        {
          this.sapAnnounce.delete(sdp);
          sdp = null;
        }
      };
    }));

    const sdpStringsWithFlow = this.sdpStringsToNMOS.filter((sdp_id, sdp) => {
      return this.sdpToNMOSFlow(sdp) !== null;
    });

    this.cleanup.add(sdpStringsWithFlow.forEachAsync((sdp, sdp_id, set) => {
      Log.info('Observed SAP announcement for SDP(%o):\n----\n%s\n----\n', sdp.id, sdp.raw);
      let closed = false;

      let device = this.nmosNode.makeDevice(this.sdpToNMOSDevice(sdp));
      Log.info('Created NMOS device %o', device.info);

      let clock = this.nmosNode.makeClock(this.sdpToNMOSClock(sdp));
      Log.info('Created NMOS clock %o', clock.info);

      let source = device.makeSource(this.sdpToNMOSSource(sdp, clock));
      Log.info('Created NMOS source %o', source.info);

      let flow = source.makeFlow(this.sdpToNMOSFlow(sdp));
      Log.info('Created NMOS source %o', flow.info);

      let iface;

      let sender = flow.makeRTPSender(this.sdpToNMOSSender(sdp, iface));
      Log.info('Created NMOS sender %o', sender.info);

      const mac_lookup_task = async () => {
        let mac;

        do
        {
          mac = await lookupMACAddress(sdp.origin_addr);

          if (closed) return;

          if (mac)
          {
            iface = this.nmosNode.makeInterface(this.macToNMOSInterface(mac));
            Log.info('Created NMOS interface %o for ip %o',
                     iface.info, sdp.origin_addr);
            sender.update(this.sdpToNMOSSender(sdp, iface));
          }
          else
          {
            Log.warn('Could not find mac address for ip %o', sdp.origin_addr);
            await delay(1000);

            if (closed) return;
          }
        }
        while (!mac);
      };

      const task = async () => {
        do
        {
          try
          {
            sdp = await set.waitForChange(sdp_id);
            Log.info('SAP announcement changed. Updating NMOS resources: %o', sdp);
          }
          catch (err)
          {
            // was deleted
            return;
          }

          device.update(this.sdpToNMOSDevice(sdp));
          clock.update(this.sdpToNMOSClock(sdp));
          sender.update(this.sdpToNMOSSender(sdp, iface));
          source.update(this.sdpToNMOSSource(sdp, clock));
          flow.update(this.sdpToNMOSFlow(sdp));
        }
        while (true);
      };

      task().catch((err) => {
        Log.error('nmos update task terminated: %o', err);
      });

      mac_lookup_task().catch((err) => {
        Log.error('MAC address lookup task terminated: %o', err);
      });

      return () => {
        Log.info('SAP announcement was deleted. Removing NMOS resources: %o', sdp);
        closed = true;
        sender.unref();
        flow.unref();
        source.unref();
        clock.unref();
        if (iface) iface.unref();
        setTimeout(() => device.unref(), 1000);
      };
    }));
  }

  close()
  {
    this.cleanup.close();
  }

  addSDPStringsToNMOS(set)
  {
    this.sdpStringsToNMOS.addSet(set);
  }

  removeSDPStringsToNMOS(set)
  {
    this.sdpStringsToNMOS.removeSet(set);
  }

  // SAP -> NMOS
  sdpToNMOSDevice(sdp)
  {
    const id = uuid('device:'+sdp.origin_addr, this.nmosNode.id);

    const info = {
      id: id,
      version: NMOS.makeVersion(),
      label: sdp.name.split(':')[0].trim(),
      description: '',
      tags: {},
      type: "urn:x-nmos:device:generic",
      senders: [],
      receivers: [],
      controls: [
        {
          type: "urn:x-nmos:control:manifest-base/v1.3",
          href: "http://example.org/x-nmos/senders",
        }
      ],
    };

    return info;
  }

  sdpToNMOSSender(sdp, iface)
  {
    const id = uuid('sender:'+sdp.id, this.nmosNode.id);

    const info = {
      id: id,
      version: NMOS.makeVersion(),
      label: sdp.name,
      sdp: sdp,
      description: '',
      tags: {},
      // flow_id will be filled by flow
      transport: 'urn:x-nmos:transport:rtp.mcast',
      interface_bindings: [ ],
      subscription: { receiver_id: null, active: false }
    };

    if (iface) info.interface_bindings.push(iface.id);

    return info;
  }

  sdpToNMOSSource(sdp, clock)
  {
    const id = uuid('source:'+sdp.id, this.nmosNode.id);

    const info = {
      id: id,
      version: NMOS.makeVersion(),
      label: sdp.name,
      description: '',
      tags: {},
      caps: {},
      // device_id is filled by the device
      parents: [],
      clock_name: clock ? clock.id : null,
      format: "urn:x-nmos:format:audio",
      channels: [
        {
          label: "Channel",
        }
      ],
    };

    return info;
  }

  sdpToNMOSFlow(sdp)
  {
    const id = uuid('flow:'+sdp.id, this.nmosNode.id);

    let media_type;
    let bit_depth;
    let sample_rate;

    for (let attribute of sdp.get_fields('a'))
    {
      if (!attribute.startsWith('rtpmap:')) continue;
      if (attribute.includes('L24'))
      {
        media_type = 'audio/L24';
        bit_depth = 24;
      }
      else if (attribute.includes('L20'))
      {
        media_type = 'audio/L20';
        bit_depth = 20;
      }
      else if (attribute.includes('L16'))
      {
        media_type = 'audio/L16';
        bit_depth = 16;
      }
      else if (attribute.includes('L8'))
      {
        media_type = 'audio/L8';
        bit_depth = 8;
      }
      else continue;

      sample_rate = parseInt(attribute.split('/')[1]);
    }

    if (!media_type)
      return null;

    const info = {
      id: id,
      version: NMOS.makeVersion(),
      label: sdp.name,
      description: '',
      tags: {},
      // device_id is filled by the device
      // source_id is filled by the source
      format: "urn:x-nmos:format:audio",
      sample_rate: {
        numerator: sample_rate,
        denominator: 1,
      },
      media_type: media_type,
      bit_depth: bit_depth,
      parents: [],
    };

    return info;
  }

  sdpToNMOSClock(sdp)
  {
    const clock = sdp.ptp_clock;

    if (!clock || !clock.gmid)
    {
      return {
        ref_type: 'internal',
      };
    }

    return {
      ref_type: 'ptp',
      traceable: clock.traceable,
      version: clock.version,
      gmid: clock.gmid.toLowerCase(),
      locked: false,
    };
  }

  macToNMOSInterface(mac)
  {
    const id = mac.toLowerCase().replace(/:/g, '-');
    return {
      port_id: id,
      chassis_id: id,
    };
  }
}

module.exports = Proxy;
