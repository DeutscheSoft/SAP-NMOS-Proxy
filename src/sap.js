const UDP = require('dgram');
const Events = require('events');
const util = require('util');
const net = require('net');
const Cleanup = require('./event_helpers.js').Cleanup;
const SDP = require('./sdp.js');
const DynamicSet = require('./dynamic_set.js').DynamicSet;


// Adhering to RFC 2974 apparently is neither popular nor useful. Instead, we
// will assume announcements are due every 30 seconds, which is at least what
// our current hardware seems to do.
const AD_INTERVAL = 30;
const NO_OF_ADS = 10; // Timeout after this amount has been missed.

function sleep(duration) {
    return new Promise(resolve => setTimeout(resolve, duration * 1000));
}

function whenOne(them) {
    return new Promise(resolve => {
        them.forEach((promise, idx) => {
            promise.then(() => resolve(idx), () => resolve(idx));
        });
    });
}


function read_cstring(buf, pos)
{
  const start = pos;

  while (buf.readUInt8(pos)) pos ++;

  return [ pos+1, buf.toString('ascii', start, pos) ];
}

/**
 * SAP Packet.
 */
class Packet
{
  constructor(o)
  {
    const source = o.source;

    if (!net.isIP(source))
      throw new TypeError('IP address expected as source argument.');

    const auth = o.auth || null;

    if (auth !== null)
    {
      if (auth instanceof Buffer)
      {
        if (auth.length % 4)
          throw new Error('Authentication data must be a multiple of 4 bytes.');
      }
      else
      {
        throw new TypeError('Authentication data should be either null or a Buffer.');
      }
    }

    const hash = o.hash || 0;

    if (typeof hash !== 'number')
      throw new Error('Message Identification Hash must be a number.');

    this.source = source;
    this.auth = auth;
    this.hash = hash;
    this.payload_type = o.payload_type || 'application/sdp';
    this.payload = o.payload.toString();
    this.deletion = !!(o.deletion);

    if (this.has_sdp_payload())
    {
      if (o.payload instanceof SDP)
        this.sdp = o.payload;
      else
        this.sdp = new SDP(o.payload);
    }
    else
    {
      this.sdp = null;
    }
  }

  /**
   * Returns true if this packet is an announcement.
   */
  is_announcement()
  {
    return !this.deletion;
  }

  /**
   * Returns true if this packet contains sdp payload.
   */
  has_sdp_payload()
  {
    return this.payload_type === 'application/sdp';
  }

  /**
   * The SDP payload.
   */
  get id()
  {
    if (!this.has_sdp_payload())
    {
      throw new Error('Payload type is not SDP');
    }

    return this.sdp.id;
  }

  /**
   * Encode the SDP payload into a Buffer object.
   */
  toBuffer(compression)
  {
    if (compression)
      throw new Error('Compression is not supported, yet.');

    const ipv4 = net.isIPv4(this.source);
    const length = 1 + 1 + 2 + (ipv4 ? 4 : 16)
        + (this.auth === null ? 0 : this.auth.length)
        + this.payload.length + this.payload_type.length + 1;

    const buf = Buffer.alloc(length);
    let pos = 0;

    // flags
    {
      let flags = 0;

      flags |= 1 << 5; // version

      if (!ipv4) flags |= 16; // A
      // R
      if (!this.is_announcement()) flags |= 4;
      // E
      if (compression) flags |= 1;

      buf.writeUInt8(flags, pos++);
    }

    buf.writeUInt8(this.auth !== null ? (this.auth.length / 4) : 0, pos++);
    buf.writeUInt16BE(this.hash, pos); pos += 2;

    if (ipv4)
    {
      this.source.split('.').map((s) => parseInt(s)).forEach((v) => { buf.writeUInt8(v, pos++); });
    }
    else
    {
      throw new Error('IPv6 not supported, yet.');
    }

    if (this.auth)
    {
      this.auth.copy(buf, pos);
      pos += this.auth.length;
    }

    buf.write(this.payload_type, pos); pos += this.payload_type.length;
    buf.writeUInt8(0, pos++);
    buf.write(this.payload, pos);

    return buf;
  }

  /**
   * Decodes an SDP Packet from a Buffer object.
   */
  static fromBuffer(buf)
  {
    let pos = 0;
    let tmp = buf.readUInt8(pos++);

    const V = tmp >> 5;
    const A = !!(tmp & 16);
    //const R = !!(tmp & 8);
    const T = !!(tmp & 4);
    const E = !!(tmp & 2);
    const C = !!(tmp & 1);

    if (V !== 1)
    {
      throw new Error("Bad SAP packet version: " + V);
    }

    const auth_length = buf.readUInt8(pos++);
    const hash = buf.readUInt16BE(2); pos += 2;

    let source;

    if (A)
    {
      throw new Error('ipv6 not supported.');
    }
    else
    {
      source = util.format('%d.%d.%d.%d',
                           buf.readUInt8(pos++),
                           buf.readUInt8(pos++),
                           buf.readUInt8(pos++),
                           buf.readUInt8(pos++));
    }

    let auth = null;

    if (auth_length)
    {
      auth = buf.slice(pos, auth_length * 4);
      pos += auth_length * 4;
    }

    if (E)
    {
      throw new Error('encryption no supported');
    }

    let payload_type;

    [ pos, payload_type ] = read_cstring(buf, pos);

    const payload = buf.toString('ascii', pos);

    return new Packet({
      source: source,
      auth: auth,
      hash: hash,
      payload_type: payload_type,
      payload: payload,
      deletion: T,
    });
  }
}

class Hasher {
    constructor() {
        this.sdps = new Map();
        this.used_ids = new Map();
        this.cnt = Math.floor(Math.random() * 0xffff);
    }

    get_id() {
        if (this.sdps.size == 0xfffe)
            throw new Error('All IDs used up.');

        while (this.used_ids.has(this.cnt
                                 = Math.max((this.cnt + 1) & 0xffff, 1)));

        return this.cnt;
    }

    record(sdp) {
        let hash = this.sdps.get(sdp.toString());
        let id;

        if (hash)
            return hash;

        id = this.get_id();
        this.used_ids.set(id, sdp.toString());
        this.sdps.set(sdp.toString(), id);

        return id;
    }

    expire(hashOrSdp) {
        let ret;

        if (typeof hashOrSdp === 'number') {
            if (!this.used_ids.has(hashOrSdp))
                throw new Error('Unknown id');

            ret = hashOrSdp;
            this.sdps.delete(this.used_ids.get(hashOrSdp));
            this.used_ids.delete(hashOrSdp);
        } else if (hashOrSdp instanceof SDP) {
            if (!this.sdps.has(hashOrSdp.toString()))
                throw new Error("Unknown SDP");

            this.used_ids.delete(ret = this.sdps.get(hashOrSdp.toString()));
            this.sdps.delete(hashOrSdp.toString());
        } else {
            throw new Error("Called with unknown type");
        }

        return ret;
    }
}

/**
 * Port class which allows listening for SAP packets.
 */
class Port extends Events
{
  constructor(iface)
  {
    let waiters;

    super();
    this.waiters = [];
    this.hasher = new Hasher();
    this.socket = UDP.createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => {
      try
      {
        const packet = Packet.fromBuffer(msg);

        this.emit('message', packet);

        const buf = packet.toBuffer();

        if (Buffer.compare(buf, msg))
        {
          console.error(buf);
          console.error(msg);
          throw new Error('mismatch.');
        }
      }
      catch (e)
      {
        this.emit('error', e);
      }
    });
    this.socket.bind(9875, () => {
      if (iface)
      {
        this.socket.addMembership('239.255.255.255', iface);
        this.socket.setMulticastInterface(iface);
      }
      else
        this.socket.addMembership('239.255.255.255');

      waiters = this.waiters;
      this.waiters = null;

      waiters.forEach(cb => {
        try
        {
          cb(this);
        }
        catch (e)
        {
        }
      });
    });
  }

  announce(sdp) {
    const sap = new Packet({
      source: sdp.origin_addr,
      hash: this.hasher.record(sdp),
      payload: sdp,
    });

    this.socket.send(sap.toBuffer(), 9875, '239.255.255.255');
  }

  retract(sdp) {
    const sap = new Packet({
      source: sdp.origin_addr,
      hash: this.hasher.expire(sdp),
      payload: sdp,
      deletion: true,
    });

    this.socket.send(sap.toBuffer(), 9875, '239.255.255.255');
  }

  close()
  {
    this.socket.close();
  }

  onReady()
  {
    if (this.waiters)
      return new Promise(ok => this.waiters.push(ok));
    else
      return Promise.resolve(this);
  }
}

/**
 * This class manages a dynamic list of announcements received on a given
 * port. It handles session deletions and fires appropriate events.
 */
class Announcements extends DynamicSet
{
  get sessions()
  {
    return this.entries;
  }

  constructor(port)
  {
    super();
    this.port = port;
    this._timeouts = new Map();
    this.ignores = null;
    this._on_message = (packet) => {
      if (!packet.has_sdp_payload()) return;

      const id = packet.id;
      const prev_sdp = this.get(id);

      if (packet.is_announcement())
      {
        const sdp = packet.sdp;

        if (this.ignores && this.ignores.has(sdp))
          return;

        const timeout = () => {
          this._timeouts.delete(id);
          this.delete(id, packet);
        };

        if (prev_sdp)
        {
          clearTimeout(this._timeouts.get(id));
          this._timeouts.set(id, setTimeout(timeout, AD_INTERVAL * NO_OF_ADS *
                                            1000));
          if (sdp.raw === prev_sdp.raw) return;
          this.update(id, sdp, packet);
        }
        else
        {
          this.add(id, sdp, packet);
          this._timeouts.set(id, setTimeout(timeout, AD_INTERVAL * NO_OF_ADS *
                                            1000));
        }
      }
      else
      {
        if (!prev_sdp) return;
        clearTimeout(this._timeouts.get(id));
        this._timeouts.delete(id);
        this.delete(id, packet, true);
      }
    };
    this.port.on('message', this._on_message);
  }

  /**
   * Stop listening for announcements on the port.
   */
  close()
  {
    super.close();
    this.port.removeEventListener('message', this._on_message);
  }

  ignoreFrom(ownAnnouncements)
  {
    this.ignores = ownAnnouncements;
  }
}

class OwnAnnouncements extends DynamicSet {
    constructor() {
        super();
        this.sdp_strings = new Map();
    }

    announceToPort(port) {
        const cleanup = new Cleanup();
        cleanup.add(this.forEachAsync(async (ig, sdp) => {
            const delete_p = this.waitForDelete(sdp);
            const cleanup_p = cleanup.whenClosed();

            port.announce(sdp);

            do {
                switch (await whenOne([ delete_p, sleep(AD_INTERVAL),
                                      cleanup_p ])) {
                    case 0: // delete
                    case 2:
                        port.retract(sdp);
                        return;
                    case 1:
                        port.announce(sdp);
                        break;
                }
            } while (true);
        }));

        return cleanup;
    }

    add(sdp) {
        let s = sdp.toString();

        if (this.sdp_strings.has(s))
            throw new Error("Already have this SDP.");

        this.sdp_strings.set(s, sdp);
        super.add(sdp);
    }

    delete(sdp) {
        super.delete(sdp);
        this.sdp_strings.delete(sdp.toString());
    }

    has(sdp) {
        sdp = sdp.toString();

        if (!this.sdp_strings.has(sdp))
            return false;

        sdp = this.sdp_strings.get(sdp);

        return super.has(sdp);
    }
}

module.exports = {
  Port: Port,
  Announcements: Announcements,
  OwnAnnouncements: OwnAnnouncements,
};
