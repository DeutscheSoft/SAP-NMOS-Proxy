const UDP = require('dgram');
const Events = require('events');
const util = require('util');
const net = require('net');

function read_cstring(buf, pos)
{
  const start = pos;

  while (buf.readUInt8(pos)) pos ++;

  return [ pos+1, buf.toString('ascii', start, pos) ];
}

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
  }

  is_announcement()
  {
    return !this.deletion;
  }

  has_sdp_payload()
  {
    return this.payload_type === 'application/sdp';
  }

  get sdp()
  {
    if (!this.has_sdp_payload())
    {
      throw new Error('Payload type is not SDP');
    }

    return this.payload;
  }

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
    });
  }
}

class Port extends Events
{
  constructor()
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
      this.socket.addMembership('239.255.255.255');
    });
  }

  close()
  {
    this.socket.close();
  }
}

module.exports = {
  Port: Port,
};
