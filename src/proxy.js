const Events = require('events');
const os = require('os');

const util = require('util');
const Cleanup = require('./event_helpers.js').Cleanup;
const NMOS = require('./nmos.js');
const Log = require('./logger.js');
const SAP = require('./sap.js');
const SDP = require('./sdp.js');


const uuid = require('uuid/v5');

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
    this.nmosNode = new NMOS.Node({
      ip: ip,
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
    this.nmosSenders = NMOS.Discovery.AllSenders({ interface: ip });
    this.nmosSendersWithSDP = this.nmosSenders.asyncFilter(async (sender_id, sender) => {
      let sdp = null;

      if (this.nmosNode.hasDevice(sender.json.device_id))
      {
        Log.info('Sender id %o was generated by us. Ignoring.', sender.id);
        return false;
      }

      const dev = await sender.api.fetchDevice(sender.info.device_id);

      if (this.nmosNode.id === dev.node_id)
      {
        Log.info('Found sender %o which is part of our own NMOS node. Ignoring.',
                 sender.id);
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
        Log.error("Failed to fetch SDP string from sender %o", sender);
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

    // SAP -> NMOS
    const sdpToNMOSDevice = (sdp) => {
      const id = uuid('device:'+sdp.origin_addr, node_id);

      const info = {
        id: id,
        version: util.format('%d:%d', Date.now(), 0),
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
    };

    const sdpToNMOSSender = (sdp) => {
      const id = uuid('sender:'+sdp.id, node_id);

      const info = {
        id: id,
        version: util.format('%d:%d', Date.now(), 0),
        label: sdp.name,
        sdp: sdp,
        description: '',
        tags: {},
        // flow_id will be filled by flow
        transport: 'urn:x-nmos:transport:rtp.mcast',
        interface_bindings: [],
        subscription: { receiver_id: null, active: false }
      };

      return info;
    };

    const sdpToNMOSSource = (sdp) => {
      const id = uuid('source:'+sdp.id, node_id);

      const info = {
        id: id,
        version: util.format('%d:%d', Date.now(), 0),
        label: sdp.name,
        description: '',
        tags: {},
        caps: {},
        // device_id is filled by the device
        parents: [],
        clock_name: null,
        format: "urn:x-nmos:format:audio",
        channels: [
          {
            label: "Channel",
          }
        ],
      };

      return info;
    };

    const sdpToNMOSFlow = (sdp) => {
      const id = uuid('flow:'+sdp.id, node_id);

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
        version: util.format('%d:%d', Date.now(), 0),
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
    };

    const sdpStringsWithFlow = this.sdpStringsToNMOS.filter((sdp_id, sdp) => {
      return sdpToNMOSFlow(sdp) !== null;
    });

    this.cleanup.add(sdpStringsWithFlow.forEachAsync((sdp, sdp_id, set) => {
      Log.info('Observed SAP announcement %o', sdp);
      let closed = false;

      let device = this.nmosNode.makeDevice(sdpToNMOSDevice(sdp));
      Log.info('Created NMOS device %o', device.info);

      let source = device.makeSource(sdpToNMOSSource(sdp));
      Log.info('Created NMOS source %o', source.info);

      let flow = source.makeFlow(sdpToNMOSFlow(sdp));
      Log.info('Created NMOS source %o', flow.info);

      let sender = flow.makeRTPSender(sdpToNMOSSender(sdp));
      Log.info('Created NMOS sender %o', sender.info);

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

          device.update(sdpToNMOSDevice(sdp));
          sender.update(sdpToNMOSSender(sdp));
          source.update(sdpToNMOSSource(sdp));
          flow.update(sdpToNMOSFlow(sdp));
        }
        while (true);
      };

      task().catch((err) => {
        Log.error('nmos update task terminated: %o', err);
      });

      return () => {
        Log.info('SAP announcement was deleted. Removing NMOS resources: %o', sdp);
        closed = true;
        sender.unref();
        flow.unref();
        source.unref();
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
}

module.exports = Proxy;
