const os = require('os');

const DynamicSet = require('./dynamic_set.js').DynamicSet;

class Interfaces extends DynamicSet
{
  constructor(interval, filter)
  {
    super();
    if (!filter) filter = (ifname, info) => {
      return !info.internal && info.family === 'IPv4';
    };
    this.filter = filter;
    this.poll_id = setInterval(() => this.fetch(), interval || 5000);
    this.fetch();
  }

  fetch()
  {
    const interfaces = os.networkInterfaces();

    const found = new Set();

    for (let ifname in interfaces)
    {
      const addresses = interfaces[ifname];

      for (let i = 0; i < addresses.length; i++)
      {
        const info = addresses[i];

        if (!this.filter(ifname, info)) continue;

        found.add(ifname);

        if (this.has(ifname))
        {
          const prev = this.get(ifname);

          // FIXME: I assume the info is always created in the same order by the
          // os module. This is not guaranteed but let's assume it is the case.
          // If this is not correct anymore at some point we will get spurious
          // update events here.
          if (prev !== info && JSON.stringify(prev) !== JSON.stringify(info))
          {
            this.update(ifname, info);
          }
        }
        else
        {
          this.add(ifname, info);
        }
      }
    }

    this.forEach((info, ifname) => {
      if (!found.has(ifname))
        this.delete(ifname);
    });
  }

  close()
  {
  }
}

module.exports = {
  Interfaces: Interfaces,
};
