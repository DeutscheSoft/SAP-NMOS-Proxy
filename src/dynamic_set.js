const Events = require('events');
const Cleanup = require('./event_helpers.js').Cleanup;

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

  close()
  {
    this.closed = true;
    this.emit('close');
    this.entries.clear();
  }

  union(...sets)
  {
    return new UnionSet(this, ...sets);
  }

  filter(cb)
  {
    return new FilteredSet(this, cb);
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
      this.updateEntryFrom(set, id, entry, ...extra);
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
    this.filter = filter;
    const cleanup = new Cleanup();

    this.cleanup = cleanup;

    cleanup.subscribe(set, 'add', (id, entry, ...extra) => {
      if (filter(id, entry))
      {
        this.add(id, entry);
      }
    });
    cleanup.subscribe(set, 'update', (id, entry, prev, ...extra) => {
      const was = this.has(id);
      const will = filter(id, entry);

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
      if (filter(id, entry))
        this.add(id, entry);
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
  FilteredSet: FilteredSet,
};
