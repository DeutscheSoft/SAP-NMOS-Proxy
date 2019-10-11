const Events = require('events');
const Cleanup = require('./event_helpers.js').Cleanup;

class DynamicSet extends Events
{
  constructor()
  {
    super();
    this.entries = new Map();
  }

  has(id)
  {
    return this.entries.has(id);
  }

  get(id)
  {
    return this.entries.get(id);
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

  delete(id, ...extra)
  {
    if (!this.entries.has(id))
      throw new Error('Entry with given id does not exist.');

    const prev = this.entries.get(id);

    this.entries.delete(id);
    this.emit('delete', id, entry, ...extra);
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

  forEach(cb, ctx)
  {
    return this.entries.forEach(cb, ctx);
  }

  forEachAsync(cb, ctx)
  {
    if (!ctx) ctx = this;
    const cleanup = new Cleanup();

    this.forEach(cb, ctx);

    cleanup.subscribe(this, 'add', (id, entry) => {
      cb.call(ctx, entry, id);
    });

    this.on('close', () => cleanup.close());

    return cleanup;
  }

  close()
  {
    this.emit('close');
    this.entries.clear();
  }
}

module.exports = DynamicSet;
