const Events = require('events');
const os = require('os');

const Cleanup = require('./event_helpers.js').Cleanup;
const NMOS = require('./nmos.js');
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

    this.emit('log', 'Starting proxy on interface %s', ip);

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

    this.sapPort = new SAP.Port(ip);
    this.sapAnnouncements = new SAP.Announcements(this.sapPort);
    this.sapAnnounce = new SAP.OwnAnnouncements();
    this.sapAnnouncements.ignoreFrom(this.sapAnnounce);
    this.nmosSenders = NMOS.Discovery.AllSenders({ interface: ip });

    this.cleanup.add(() => {
      this.nmosSenders.close();
      this.sapAnnounce.close();
      this.sapAnnouncements.close();
      this.sapPort.close();
      this.nmosNode.close();
    });

    // NMOS -> SAP
    this.cleanup.add(this.nmosSenders.forEachAsync((sender, sender_id) => {
      this.emit('log', 'Found NMOS sender: %o\n', sender);

      let sdp = null;
      let closed = false;

      const task = async () => {
        do
        {
          const change_p = this.nmosSenders.waitForChange(sender_id);
          if (sender.info.transport.startsWith('urn:x-nmos:transport:rtp'))
          {
            try
            {
              const _sdp = new SDP(await sender.fetchManifest());
              if (!closed)
              {
                this.sapAnnounce.add(_sdp);
                this.emit('log', 'Created SAP announcement for %o', _sdp.id);
                sdp = _sdp;
              }
            }
            catch (err)
            {
              console.warn('announceing SAP failed:', err);
            }
          }
          else if (sdp)
          {
            this.sapAnnounce.delete(sdp);
            sdp = null;
          }

          try
          {
            sender = await change_p;
            if (closed) return;
          }
          catch (err)
          {
            // end task
            return;
          }
          sender = senders.get(sender_id);
        } while (true);
      };

      // run
      task().catch((err) => { console.error('sap announcement task failed.', err); });

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
        type: "urn:x-nmos:device:audio",
        node_id: PROXY_NAMESPACE,
        senders: [],
        receivers: [],
        controls: [],
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
        flow_id: id,
        transport: 'urn:x-nmos:transport:rtp.mcast',
        interface_bindings: [],
        subscription: { receiver_id: null, active: false }
      };

      return info;
    };

    this.cleanup.add(this.sapAnnouncements.forEachAsync((sdp, sdp_id) => {
      this.emit('log', 'Observed SAP announcement %o', sdp);
      let closed = false;

      let device = node.makeDevice(sdpToNMOSDevice(sdp));
      this.emit('log', 'Created NMOS device %o', device.json);

      let sender = device.makeRTPSender(sdpToNMOSSender(sdp));
      this.emit('log', 'Created NMOS sender %o', sender.json);

      const task = async () => {
        do
        {
          try
          {
            sdp = await this.sapAnnouncements.waitForChange(sdp_id);
          }
          catch (err)
          {
            // was deleted
            return;
          }

          device.update(sdpToNMOSDevice(sdp));
          sender.update(sdpToNMOSSender(sdp));
        } while (true);
      };

      task();

      return () => {
        closed = true;
        sender.close();
        // FIXME: devices are shared. we could delete them using refcounting
        // but until we have that implemented we just keep it around.
        // device.close();
      };
    }));
  }

  close()
  {
    this.cleanup.close();
  }
}

module.exports = Proxy;
