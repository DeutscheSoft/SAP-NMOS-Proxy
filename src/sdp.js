class SDP
{
  constructor(raw)
  {
    this.raw = raw;
    this.lines = this.raw.split('\r\n');

    {
      const [ username, session_id, session_version, nettype, addrtype, addr ] = this.origin.split(' ');
      this.addr = addr;
      // From RFC 4566:
      //<sess-id> is a numeric string such that the tuple of <username>,
      //      <sess-id>, <nettype>, <addrtype>, and <unicast-address> forms a
      //      globally unique identifier for the session.  The method of
      //      <sess-id> allocation is up to the creating tool, but it has been
      //      suggested that a Network Time Protocol (NTP) format timestamp be
      //      used to ensure uniqueness [13].
      this.id = [ username, session_id, nettype, addrtype, addr ].join(' ');
    }
  }

  get_fields(c)
  {
    const values = [];

    for (let line of this.lines)
    {
      if (!line.startsWith(c)) continue;
      if (line.charCodeAt(c.length) !== '='.charCodeAt(0)) continue;

      values.push(line.substr(c.length + 1));
    }

    return values;
  }

  get_field(c, def)
  {
    const values = this.get_fields(c);

    if (values.length === 0)
    {
      if (arguments.length == 2) return def;
      throw new Error('Field not found.');
    }

    if (values.length > 1)
      throw new Error('Field is not unique.');

    return values[0];
  }

  get origin()
  {
    return this.get_field('o');
  }

  get name()
  {
    return this.get_field('s', null);
  }

  get origin_addr()
  {
    const [ username, session_id, session_version, nettype, addrtype, addr ] = this.origin.split(' ');
    return addr;
  }

  get origin_address()
  {
    return this.origin_addr;
  }

  toString()
  {
    return this.raw;
  }

  get ptp_clock()
  {
    for (let val of this.get_fields('a'))
    {
      // rfc7273 PTP
      const rfc7273prefix = "ts-refclk:ptp=";
      if (val.startsWith(rfc7273prefix))
      {
        const clksrc = val.substr(rfc7273prefix.length);
        let traceable = false;
        let version, gmid, domain;

        const tmp = clksrc.split(':');

        if (tmp.length === 3)
        {
          [ version, gmid, domain ] = tmp;
        }
        else if (tmp.length === 2 && tmp[1] === 'traceable')
        {
          version = tmp[0];
          traceable = true;
        }
        else continue;

        return {
          type: 'ptp',
          gmid: gmid,
          version: version,
          domain: domain,
          traceable: traceable,
        };
      }
    }
  }

  get connection_data()
  {
    const fields = this.get_fields('c');

    return fields.map((tmp) => {
      const a = tmp.split(' ');

      if (a.length !== 3)
        throw new Error('Malformed connection data in SDP string.');

      return {
        nettype: a[0],
        addrtype: a[1],
        address: a[2],
      };
    });
  }
}

module.exports = SDP;
