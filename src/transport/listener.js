// The listener link of a network endpoint (docs/transport.md → Network endpoint): one TCP server whose accepted
// sockets become `accept` sessions with via 'direct'. `createServer` is net.createServer unless injected (tests).

export function listenerLink({ host, port, createServer }) {
  return (core) => {
    const { log } = core;
    let server = null;
    let listening = null;
    let boundPort = null;

    // A listener that fails after it is up is closed (its port freed) and forgotten; peers already connected keep
    // their sessions, and the next start() listens again.
    function forget(srv) {
      if (server !== srv) return;
      server = null;
      listening = null;
      boundPort = null;
    }

    function listen() {
      if (listening) return listening;
      const srv = createServer((socket) => { core.accept(socket, { via: 'direct' }); });
      server = srv;
      listening = new Promise((resolve, reject) => {
        const failed = (err) => { forget(srv); reject(err); };
        srv.once('error', failed);
        srv.listen(port, host, () => {
          srv.off('error', failed);
          srv.on('error', (err) => {
            log.warn(`code-inbox: the listener failed and was closed: ${err.message}`);
            forget(srv);
            srv.close();
          });
          boundPort = srv.address().port;
          resolve();
        });
      });
      return listening;
    }

    const none = () => Promise.resolve();
    return {
      listener: true,
      open: listen,
      identitiesChanged() {},
      // Closes the listener synchronously, so the port is free at once.
      shutdown() {
        if (server) server.close();
        server = null;
        listening = null;
        boundPort = null;
      },
      connect: none,
      dial: none,
      announceChanged() {},
      present: () => [],
      status: () => ({ listening: server && boundPort !== null ? { host, port: boundPort } : null }),
    };
  };
}
