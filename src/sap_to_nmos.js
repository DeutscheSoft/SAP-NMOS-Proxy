const Cleanup = require('./event_helpers.js').Cleanup;

function whenOne(it)
{
  return new Promise((resolve, reject) => {
    it.forEach((p, index) => {
      p.then(() => resolve(index), (e) => resolve(index));
    });
  });
}

function announce_to_registry(sap_announcements, registry)
{
  const cleanup = new Cleanup();

  cleanup.add(sap_announcements.forEachAsync(async (sdp, id) => {
    const delete_p = sap_announcements.waitForDeletion(id);
    const cleanup_p = cleanup.whenClosed();

    do
    {
      console.log('publishing %o to nmos registry %o', sdp.id, registry.url.href);

      const update_p = sap_announcements.waitForUpdate(id);

      // item was deleted
      switch (await whenOne([ update_p, delete_p, cleanup_p ]))
      {
      case 0: // update
        console.log('item was updated', id);
        sdp = await update_p;
        break;
      case 1:
        console.log('removing %o from nmos registry %o.', sdp.id, registry.url.href);
        return;
      case 2:
        console.log('cleanup called');
        return;
      }
    }
    while (true);
  }));

  return cleanup;
}


module.exports = {
  announce_to_registry: announce_to_registry,
};
