const Log = require('./logger.js');

class Cleanup
{
  constructor()
  {
    this.subscriptions = [];
    this.closed = false;
    this.pendingTimeouts = new Set();
    this.pendingIntervals = new Set();
  }

  add(cb)
  {
    if (this.closed)
      throw new Error('Already closed.');

    if (typeof cb === 'function')
    {
      this.subscriptions.push(cb);
    }
    else if (typeof cb === 'object' && cb instanceof Cleanup)
    {
      this.subscriptions.push(() => cb.close());
    }
  }

  setTimeout(cb, delay, ...extra)
  {
    const id = this.pendingTimeouts.add(setTimeout(() => {
      this.pendingTimeouts.delete(id);
      cb(...extra);
    }, delay));
  }

  setInterval(cb, delay, ...extra)
  {
    const id = this.pendingIntervals.add(setInterval(() => {
      this.pendingIntervals.delete(id);
      cb(...extra);
    }, delay));
  }

  sleep(duration)
  {
    return new Promise(resolve => this.setTimeout(resolve, duration * 1000));
  }

  subscribe(ctx, event, listener)
  {
    ctx.on(event, listener);
    this.add(() => ctx.removeListener(event, listener));
  }

  whenClosed()
  {
    return new Promise((resolve, reject) => {
      if (this.closed)
      {
        resolve();
      }
      else
      {
        this.add(resolve);
      }
    });
  }

  close()
  {
    if (this.closed) return;
    this.closed = true;
    this.subscriptions.forEach((cb) => {
      try
      {
        cb();
      }
      catch (err)
      {
        Log.warn('Unsubscribe failed:', err);
      }
    });
    this.pendingTimeouts.forEach(id => clearTimeout(id));
    this.pendingTimeouts.clear();
    this.pendingIntervals.forEach(id => clearInterval(id));
    this.pendingIntervals.clear();
  }

  timeout(n)
  {
    setTimeout(() => this.close(), n);
  }
}

module.exports = {
  Cleanup: Cleanup,
};
