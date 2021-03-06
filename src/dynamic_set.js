const Events = require('events');

const Cleanup = require('./event_helpers.js').Cleanup;
const Log = require('./logger.js');


function once(cb)
{
  let called = false;

  return (...args) => {
    if (called) return;
    called = true;

    return cb(...args);
  };
}

class DynamicSet extends Events
{
  constructor()
  {
    super();
    this.entries = new Map();
    this.closed = false;
    this.setMaxListeners(0);
  }

  has(id)
  {
    return this.entries.has(id);
  }

  get(id)
  {
    return this.entries.get(id);
  }

  keys()
  {
    return this.entries.keys();
  }

  values()
  {
    return this.entries.values();
  }

  add(id, entry, ...extra)
  {
    if (this.entries.has(id))
      throw new Error('Entry with given id already exists.');

    this.entries.set(id, entry);
    this.emit('add', id, entry, ...extra);
  }

  update(id, entry, ...extra)
  {
    if (!this.entries.has(id))
      throw new Error('Entry with given id does not exist.');

    const prev = this.entries.get(id);

    this.entries.set(id, entry);
    this.emit('update', id, entry, prev, ...extra);
  }

  addOrUpdate(id, entry, ...extra)
  {
    if (this.entries.has(id))
    {
      const prev = this.entries.get(id);

      this.entries.set(id, entry);
      this.emit('update', id, entry, prev, ...extra);
    }
    else
    {
      this.entries.set(id, entry);
      this.emit('add', id, entry, ...extra);
    }
  }

  delete(id, ...extra)
  {
    if (!this.entries.has(id))
      throw new Error('Entry with given id does not exist.');

    const prev = this.entries.get(id);

    this.entries.delete(id);
    this.emit('delete', id, prev, ...extra);
  }

  waitForEvent(event, id)
  {
    if (!this.entries.has(id))
      return Promise.reject(new Error('Unknown ID.'));


    return new Promise((resolve, reject) => {
      const cleanup = new Cleanup();

      cleanup.subscribe(this, event, (_id, entry) => {
        if (_id !== id) return;
        cleanup.close();
        resolve(id)
      });
      if (event !== 'close')
        cleanup.subscribe(this, 'close', () => {
          cleanup.close();
          reject(new Error('closed.'));
        });
    });
  }

  waitForDelete(id)
  {
    return this.waitForEvent('delete', id);
  }

  async waitForUpdate(id)
  {
    await this.waitForEvent('update', id)

    return this.entries.get(id);
  }

  async waitForChange(id)
  {
    if (!this.entries.has(id))
      return Promise.reject(new Error('Unknown ID.'));

    return new Promise((resolve, reject) => {
      const cleanup = new Cleanup();

      cleanup.subscribe(this, 'update', (_id, entry) => {
        if (_id !== id) return;
        cleanup.close();
        resolve(entry)
      });
      cleanup.subscribe(this, 'delete', (_id, entry) => {
        if (_id !== id) return;
        cleanup.close();
        reject(new Error('deleted.'));
      });
      cleanup.subscribe(this, 'close', () => {
        cleanup.close();
        reject(new Error('closed.'));
      });
    });
  }

  forEach(cb, ctx)
  {
    return this.entries.forEach((entry, id) => { cb.call(ctx, entry, id, this); });
  }

  forEachAsync(_cb, ctx)
  {
    if (!ctx) ctx = this;
    const cleanup = new Cleanup();

    const cb = (entry, id) => {
      let _cleanup = _cb.call(ctx, entry, id, this);

      if (!_cleanup) return;

      if (typeof _cleanup === 'function')
      {
        _cleanup = once(_cleanup);
      }
      else if ((typeof _cleanup !== 'object' || !(_cleanup instanceof Cleanup))) return;

      cleanup.add(_cleanup);

      this.waitForDelete(id).then(() => {
        if (typeof _cleanup === 'function')
        {
          _cleanup();
        }
        else
        {
          _cleanup.close();
        }
      }, () => {});
    };

    this.entries.forEach(cb);

    cleanup.subscribe(this, 'add', (id, entry) => {
      cb(entry, id);
    });

    this.on('close', () => cleanup.close());

    return cleanup;
  }

  size()
  {
    return this.entries.size;
  }

  close()
  {
    if (this.closed) return;
    this.closed = true;
    this.entries.clear();
    this.emit('close');
    this.removeAllListeners();
  }

  union(...sets)
  {
    return new UnionSet(this, ...sets);
  }

  filter(cb)
  {
    return new FilteredSet(this, cb);
  }

  asyncFilter(cb)
  {
    return new AsyncFilteredSet(this, cb);
  }

  map(cb)
  {
    return new MappedSet(this, cb);
  }

  asyncMap(cb)
  {
    return new AsyncMappedSet(this, cb);
  }

  static from(x)
  {
    if (Array.isArray(x))
    {
      const set = new this();

      x.forEach((v) => {
        set.add(v, v);
      });

      return set;
    }
    else if (typeof x === 'object')
    {
      const set = new this();

      for (let key in x)
      {
        set.add(key, x[key]);
      }

      return set;
    }
    else
    {
      throw new TypeError('Not supported.');
    }
  }
}

class UnionSet extends DynamicSet
{
  // internal methods

  addEntryFrom(set, id, entry, ...extra)
  {
    if (this.has(id)) return;
    this.add(id, entry, ...extra);
  }

  removeEntryFrom(set, id, entry, ...extra)
  {
    if (this.get(id) !== entry) return;

    // if we find another entry in a different set with
    // the same id, we generate an update, instead. If not,
    // this is a delete.
    for (let i = 0; i < this.sets.length; i++)
    {
      if (this.sets[i].has(id))
      {
        this.update(id, this.sets[i].get(id), ...extra);
        return;
      }
    }

    this.delete(id, entry, ...extra);
  }

  updateEntryFrom(set, id, entry, prev, ...extra)
  {
    if (this.get(id) !== prev) return;
    this.update(id, entry, ...extra);
  }

  /**
   * Remove a set from this union.
   */
  removeSet(set)
  {
    if (!this.cleanup.has(set))
    {
      throw Error('Unknown set: ' + set);
    }
    this.sets = this.sets.filter((_set) => _set !== set);
    this.cleanup.get(set).close();
    this.cleanup.delete(set);
    set.forEach((entry, id) => {
      this.removeEntryFrom(set, id, entry);
    });
  }

  /**
   * Adds a set to this union.
   */
  addSet(set)
  {
    if (this.cleanup.has(set))
      throw new Error('Set already added.');
    const cleanup = new Cleanup();
    this.cleanup.set(set, cleanup);
    this.sets.push(set);
    cleanup.subscribe(set, 'add', (id, entry, ...extra) => {
      this.addEntryFrom(set, id, entry, ...extra);
    });
    cleanup.subscribe(set, 'update', (id, entry, prev, ...extra) => {
      this.updateEntryFrom(set, id, entry, prev, ...extra);
    });
    cleanup.subscribe(set, 'delete', (id, entry, ...extra) => {
      this.removeEntryFrom(set, id, entry, ...extra);
    });
    cleanup.subscribe(set, 'close', () => this.removeSet(set));
    set.forEach((entry, id) => this.addEntryFrom(set, id, entry));
  }

  constructor(...sets)
  {
    super();
    this.cleanup = new Map();
    this.sets = [];
    sets.forEach((set) => this.addSet(set));
  }

  close()
  {
    super.close();
    this.cleanup.forEach((cleanup) => cleanup.close());
  }
}

class FilteredSet extends DynamicSet
{
  constructor(set, filter)
  {
    super();
    this.set = set;
    const cleanup = new Cleanup();

    const safe_filter = (...args) => {
      try
      {
        return filter(...args);
      }
      catch (err)
      {
        Log.error('FilteredSet callback generated an exception: %o', err);
        return false;
      }
    };

    this.cleanup = cleanup;

    cleanup.subscribe(set, 'add', (id, entry, ...extra) => {
      if (safe_filter(id, entry))
      {
        this.add(id, entry);
      }
    });
    cleanup.subscribe(set, 'update', (id, entry, prev, ...extra) => {
      const was = this.has(id);
      const will = safe_filter(id, entry);

      if (!was)
      {
        if (will)
        {
          this.add(id, entry);
        }
      }
      else
      {
        if (will)
        {
          this.update(id, entry);
        }
        else
        {
          this.delete(id);
        }
      }
    });
    cleanup.subscribe(set, 'delete', (id, entry, ...extra) => {
      if (this.has(id))
        this.delete(id);
    });
    cleanup.subscribe(set, 'close', () => this.close());

    set.forEach((entry, id) => {
      if (safe_filter(id, entry))
        this.add(id, entry);
    });
  }

  close()
  {
    this.cleanup.close();
    super.close();
  }
}

class MappedSet extends DynamicSet
{
  constructor(set, cb)
  {
    super();
    this.set = set;
    this.cb = cb;
    const cleanup = new Cleanup();

    this.cleanup = cleanup;

    cleanup.subscribe(set, 'add', (id, entry, ...extra) => {
      const [ _id, _entry ] = cb(id, entry);

      if (this.has(_id))
      {
        this.update(_id, _entry);
      }
      else
      {
        this.add(_id, _entry);
      }
    });
    cleanup.subscribe(set, 'update', (id, entry, prev, ...extra) => {
      const [ _id, _entry ] = cb(id, entry);

      this.update(_id, _entry);
    });
    cleanup.subscribe(set, 'delete', (id, entry, ...extra) => {
      const [ _id, _entry ] = cb(id, entry);

      this.delete(_id);
    });
    cleanup.subscribe(set, 'close', () => this.close());

    set.forEach((entry, id) => {
      const [ _id, _entry ] = cb(id, entry);

      this.add(_id, _entry);
    });
  }

  close()
  {
    this.cleanup.close();
    super.close();
  }
}

class PollingSet extends DynamicSet
{
  constructor(api, interval)
  {
    super();
    this.api = api;
    this.interval = interval || 5000;
    this.poll_id = undefined;
    this.fetch();
    this.failure_count = 0;
  }

  create(info)
  {
    return info;
  }

  makeID(info)
  {
    return info.id;
  }

  nextInterval()
  {
    let interval = this.interval;

    if (this.failure_count > 0)
    {
      interval *= Math.min(5, 1 + Math.sqrt(this.failure_count));
    }

    return interval;
  }

  async fetch()
  {
    this.poll_id = undefined;

    try
    {
      const entries = await this.fetchList();
      const found = new Set();

      if (this.closed) return;

      entries.forEach((info) => {
        const id = this.makeID(info);

        found.add(id);

        const prev = this.get(id);

        if (prev)
        {
          if (prev.version !== info.version)
            this.update(id, this.create(info));
        }
        else
        {
          this.add(id, this.create(info));
        }
      });

      this.forEach((entry, id) => {
        if (!found.has(id))
          this.delete(id);
      });
      this.failure_count = 0;
    }
    catch (err)
    {
      if (this.closed) return;

      this.failure_count++;

      Log.warn('Fetching entries failed:', err.toString());
    }

    this.poll_id = setTimeout(() => this.fetch(), this.nextInterval());
  }

  close()
  {
    super.close();
    if (this.poll_id !== undefined)
      clearTimeout(this.poll_id);
  }
}

class AsyncDynamicSet extends DynamicSet
{
  constructor()
  {
    super();

    // contains a promise per id which allows us to
    // wait for the previous one to complete
    this.tasks = new Map();
  }

  async wait_for_task(id)
  {
    let p;

    while (p = this.tasks.get(id))
    {
      try
      {
        await p;
      }
      catch (err)
      {
        // this is not our error
      }
    }
  }

  async schedule_task(id, p) {
    await this.wait_for_task(id);
    this.tasks.set(id, p);
    let result;
    try
    {
      result = await p;
      this.tasks.delete(id);
      return result;
    }
    catch (err)
    {
      this.tasks.delete(id);
      throw err;
    }
  };

  async wait()
  {
    while (this.tasks.size)
    {
      await this.tasks.values().next().value;

      await Promise.resolve();
    }
  }
}

class AsyncFilteredSet extends AsyncDynamicSet
{
  constructor(set, filter)
  {
    super();
    this.set = set;
    this.filter = filter;
    const cleanup = new Cleanup();

    this.cleanup = cleanup;

    const safe_filter = async (id, entry) => {
      try
      {
        return await this.schedule_task(id, filter(id, entry));
      }
      catch (err)
      {
        Log.error('AsyncFilteredSet callback generated an exception: %o', err);
      }

      return false;
    };

    const onadd = async (id, entry, ...extra) => {
      if (await safe_filter(id, entry))
      {
        this.add(id, entry);
      }
    };

    const onupdate = async (id, entry, prev, ...extra) => {
      const will = await safe_filter(id, entry);
      const was = this.has(id);

      if (!was)
      {
        if (will)
        {
          this.add(id, entry);
        }
      }
      else
      {
        if (will)
        {
          this.update(id, entry);
        }
        else
        {
          this.delete(id);
        }
      }
    };

    const ondelete = async (id, entry, ...extra) => {
      await this.wait_for_task(id);
      if (this.has(id))
        this.delete(id);
    };

    cleanup.subscribe(set, 'add', onadd);
    cleanup.subscribe(set, 'update', onupdate);
    cleanup.subscribe(set, 'delete', ondelete);
    cleanup.subscribe(set, 'close', () => this.close());

    set.forEach((entry, id) => { onadd(id, entry); });
  }

  close()
  {
    this.cleanup.close();
    super.close();
  }
}

class AsyncMappedSet extends AsyncDynamicSet
{
  constructor(set, cb)
  {
    super();
    this.set = set;
    this.cb = cb;
    const cleanup = new Cleanup();

    this.cleanup = cleanup;

    cleanup.subscribe(set, 'add', async (id, entry, ...extra) => {
      try
      {
        const [ _id, _entry ] = await this.schedule_task(id, cb(id, entry, this, 'add'));

        if (this.has(_id))
        {
          this.update(_id, _entry);
        }
        else
        {
          this.add(_id, _entry);
        }
      }
      catch(err)
      {
        Log.error('Callback in AsyncMappedSet generated and error:', err);
      }
    });
    cleanup.subscribe(set, 'update', async (id, entry, prev, ...extra) => {
      try
      {
        const [ _id, _entry ] = await this.schedule_task(id, cb(id, entry, this, 'update'));

        this.update(_id, _entry);
      }
      catch(err)
      {
        Log.error('Callback in AsyncMappedSet generated and error:', err);
      }
    });
    cleanup.subscribe(set, 'delete', async (id, entry, ...extra) => {
      try
      {
        const [ _id, _entry ] = await this.schedule_task(id, cb(id, entry, this, 'delete'));

        this.delete(_id);
      }
      catch(err)
      {
        Log.error('Callback in AsyncMappedSet generated and error:', err);
      }
    });
    cleanup.subscribe(set, 'close', () => this.close());

    set.forEach(async (entry, id) => {
      try
      {
        const [ _id, _entry ] = await this.schedule_task(id, cb(id, entry, this, 'add'));

        this.add(_id, _entry);
      }
      catch(err)
      {
        Log.error('Callback in AsyncMappedSet generated and error:', err);
      }
    });
  }

  close()
  {
    this.cleanup.close();
    super.close();
  }
}

module.exports = {
  DynamicSet: DynamicSet,
  UnionSet: UnionSet,
  MappedSet: MappedSet,
  AsyncMappedSet: AsyncMappedSet,
  FilteredSet: FilteredSet,
  AsyncFilteredSet: AsyncFilteredSet,
  PollingSet: PollingSet,
};
