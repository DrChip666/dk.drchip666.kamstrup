'use strict';

const Homey = require('homey');

// The module has a single TCP slot. After a socket closes, requests on a new socket
// are dropped for up to ~12 s, so every connection to a host waits for this delay.
const RECONNECT_DELAY_MS = 12000;

class SmartMeLocalApp extends Homey.App {

  async onInit() {
    this.closedAt = new Map();
    this.log('smart-me Local has been initialized');
  }

  markClosed(host) {
    this.closedAt.set(host, Date.now());
  }

  /** Milliseconds to wait before a new connection to `host` will be served. */
  connectDelay(host) {
    const closedAt = this.closedAt.get(host);
    if (!closedAt) return 0;
    return Math.max(0, RECONNECT_DELAY_MS - (Date.now() - closedAt));
  }

}

module.exports = SmartMeLocalApp;
