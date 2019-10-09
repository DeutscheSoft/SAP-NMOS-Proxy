const UDP = require('dgram');
const Events = require('events');
const util = require('util');
const net = require('net');
const Cleanup = require('./event_helpers.js').Cleanup;
const SDP = require('./sdp.js');

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
    this.payload = o.payload;
    this.deletion = !!(o.deletion);

    if (this.has_sdp_payload())
    {
      this.sdp = new SDP(o.payload);
    }
    else
    {
      this.sdp = null
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

/**
 * Port class which allows listening for SAP packets.
 */
class Port extends Events
{
  constructor(iface)
  {
    super();
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
        this.socket.addMembership('239.255.255.255', iface);
      else
        this.socket.addMembership('239.255.255.255');
    });
  }

  close()
  {
    this.socket.close();
  }
}

/**
 * This class manages a dynamic list of announcements received on a given
 * port. It handles session deletions and fires appropriate events.
 */
class Announcements extends Events
{
  constructor(port)
  {
    super();
    this.port = port;
    this.sessions = new Map();
    this._on_message = (packet) => {
      if (!packet.has_sdp_payload()) return;

      const id = packet.id;
      const prev_sdp = this.sessions.get(id);

      if (packet.is_announcement())
      {
        const sdp = packet.sdp;

        if (prev_sdp)
        {
          if (sdp.raw === prev_sdp.raw) return;
          this.sessions.set(id, sdp);
          this.emit('update', id, sdp, packet);
        }
        else
        {
          this.sessions.set(id, sdp);
          this.emit('add', id, sdp, packet);
        }
      }
      else
      {
        if (!prev_sdp) return;
        this.sessions.delete(id);
        this.emit('delete', id, prev_sdp, packet);
      }
    };
    this.port.on('message', this._on_message);
  }

  waitForEvent(event, id)
  {
    if (!this.sessions.has(id))
      return Promise.reject(new Error('Unknown ID.'));

    return new Promise((resolve, reject) => {
      const cleanup = new Cleanup();

      cleanup.subscribe(this, event, (_id, sdp, packet) => {
        if (_id !== id) return;
        cleanup.close();
        resolve(id)
      });
      cleanup.subscribe(this, 'close', () => {
        cleanup.close();
        reject(new Error('closed.'));
      });
    });
  }

  waitForDeletion(id)
  {
    return this.waitForEvent('delete', id);
  }

  async waitForUpdate(id)
  {
    await this.waitForEvent('update', id)
    
    return this.sessions.get(id);
  }

  /**
   * Stop listening for announcements on the port.
   */
  close()
  {
    this.port.removeEventListener('message', this._on_message);
    this.emit('close');
  }

  forEach(cb, ctx)
  {
    return this.sessions.forEach(cb, ctx);
  }

  forEachAsync(cb, ctx)
  {
    if (!ctx) ctx = this;
    const cleanup = new Cleanup();

    this.forEach(cb, ctx);

    cleanup.subscribe(this, 'add', (id, sdp, packet) => {
      cb.call(ctx, sdp, id);
    });

    return cleanup;
  }
}

module.exports = {
  Port: Port,
  Announcements: Announcements,
};
