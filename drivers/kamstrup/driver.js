'use strict';

const Homey = require('homey');
const { ModbusTcpClient } = require('../../lib/ModbusTcpClient');
const { BLOCKS, decodePower } = require('../../lib/registers');

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const PHASE_INDICES = {
  any: [0, 1, 2], l1: [0], l2: [1], l3: [2],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class KamstrupDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getDeviceTriggerCard('phase_current_rose_above')
      .registerRunListener(async (args, state) => {
        const limit = args.current;
        return PHASE_INDICES[args.phase].some(
          (i) => state.previous[i] <= limit && state.current[i] > limit,
        );
      });

    this.homey.flow.getConditionCard('phase_current_above')
      .registerRunListener(async (args) => {
        return PHASE_INDICES[args.phase].some((i) => {
          const value = args.device.getCapabilityValue(`measure_current.l${i + 1}`);
          return typeof value === 'number' && value > args.current;
        });
      });
  }

  isValidHost(host) {
    return IPV4.test(String(host || '').trim());
  }

  async onPair(session) {
    session.setHandler('connect', async (data) => this.testModule(String(data && data.host || '').trim()));
  }

  /** Connects once, reads the active power and returns the device to create. */
  async testModule(host) {
    if (!this.isValidHost(host)) throw new Error(this.homey.__('errors.invalid_ip'));

    if (this.getDevices().some((device) => device.getSetting('host') === host)) {
      throw new Error(this.homey.__('pair.already_added'));
    }

    const wait = this.homey.app.connectDelay(host);
    if (wait > 0) await sleep(wait);

    const client = new ModbusTcpClient({ host, timeout: 3000 });
    client.on('error', (err) => this.log(`Pairing connection error: ${err.message}`));

    try {
      await client.connect();
    } catch (err) {
      this.log(`Pairing: cannot connect to ${host}: ${err.message}`);
      throw new Error(this.homey.__(err.code === 'ECONNREFUSED' ? 'pair.refused' : 'pair.unreachable'));
    }

    let power = null;
    try {
      for (let attempt = 1; attempt <= 3 && power === null; attempt++) {
        try {
          power = decodePower(await client.readHoldingRegisters(BLOCKS.power.start, BLOCKS.power.count));
        } catch (err) {
          this.log(`Pairing: read attempt ${attempt} failed: ${err.message}`);
          if (attempt < 3) await sleep(2500);
        }
      }
    } finally {
      await client.close();
      this.homey.app.markClosed(host);
    }
    if (power === null) throw new Error(this.homey.__('pair.no_answer'));

    let mac = null;
    try {
      mac = await this.homey.arp.getMAC(host);
    } catch (err) {
      this.log(`Pairing: MAC lookup failed: ${err.message}`);
    }
    if (!mac) throw new Error(this.homey.__('pair.no_mac'));
    mac = mac.toLowerCase();

    if (this.getDevices().some((device) => device.getData().id === mac)) {
      throw new Error(this.homey.__('pair.already_added'));
    }

    this.log(`Pairing: found module ${mac} at ${host}, ${power} W`);
    return {
      device: {
        name: 'smart-me Kamstrup',
        data: { id: mac },
        settings: { host, mac },
      },
      power,
    };
  }

}

module.exports = KamstrupDriver;
