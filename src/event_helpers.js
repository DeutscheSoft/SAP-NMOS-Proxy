class Cleanup
{
  constructor()
  {
    this.subscriptions = [];
    this.closed = false;
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
        console.warn('Unsubscribe failed:', err);
      }
    });
  }

  timeout(n)
  {
    setTimeout(() => this.close(), n);
  }
}

module.exports = {
  Cleanup: Cleanup,
};
