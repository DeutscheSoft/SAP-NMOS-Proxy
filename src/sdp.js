class SDP
{
  constructor(raw)
  {
    this.raw = raw;

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

    for (let line of this.raw.split('\r\n')) {
      const [ type, value ] = line.split('=');

      if (type === c)
      {
        values.push(value);
      }
    }

    return values;
  }

  get_field(c)
  {
    const values = this.get_fields(c);

    if (values.length === 0)
      throw new Error('Field not found.');

    if (values.length > 1)
      throw new Error('Field is not unique.');

    return values[0];
  }

  get origin()
  {
    return this.get_field('o');
  }

  toString()
  {
    return this.raw;
  }
}

module.exports = SDP;
