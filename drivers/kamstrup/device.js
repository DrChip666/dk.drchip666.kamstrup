'use strict';

const Homey = require('homey');
const { ModbusTcpClient } = require('../../lib/ModbusTcpClient');
const {
  BLOCKS, decodePower, decodePhases, decodeEnergy,
} = require('../../lib/registers');

// Power is read every other request; phases and energy alternate in between.
const CYCLE = ['power', 'phases', 'power', 'energy'];
const MIN_REQUEST_INTERVAL_MS = 2000; // the module drops requests closer together than this
const REQUEST_TIMEOUT_MS = 3000;
const FAILURES_BEFORE_RECONNECT = 3;
const FAILURES_BEFORE_UNAVAILABLE = 6;
const PHASES = ['l1', 'l2', 'l3'];
const STATUS_LOG_INTERVAL_MS = 60 * 1000;
const STALE_WARNING_MS = 3 * 60 * 1000;

class KamstrupDevice extends Homey.Device {

  async onInit() {
    this.client = null;
    this.cycleIndex = 0;
    this.failures = 0;
    this.stopped = false;
    this.timer = null;
    this.stats = { ok: 0, failed: 0 };
    this.lastChangeAt = Date.now();
    this.staleWarned = false;
    this.statusTimer = this.homey.setInterval(() => this.logStatus(), STATUS_LOG_INTERVAL_MS);
    await this.unsetWarning().catch(this.error); // a warning from before a restart may be outdated

    this.phaseCurrentsChanged = this.homey.flow.getDeviceTriggerCard('phase_currents_changed');
    this.phaseCurrentRoseAbove = this.homey.flow.getDeviceTriggerCard('phase_current_rose_above');

    this.log(`Starting, module at ${this.getSetting('host')}`);
    this.schedule(0);
  }

  // --- polling loop ---------------------------------------------------------

  schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer) this.homey.clearTimeout(this.timer);
    this.timer = this.homey.setTimeout(() => {
      this.timer = null;
      this.tick().catch(this.error);
    }, delayMs);
  }

  requestInterval() {
    const seconds = Number(this.getSetting('request_interval')) || 2.5;
    return Math.max(MIN_REQUEST_INTERVAL_MS, seconds * 1000);
  }

  async tick() {
    if (this.stopped) return;
    let next = this.requestInterval();
    try {
      next = await this.poll();
    } catch (err) {
      // Never let an unexpected error end the polling loop.
      this.error('Unexpected error in polling loop:', err);
    } finally {
      this.schedule(next);
    }
  }

  /** One request. Returns the delay before the next one. */
  async poll() {
    const host = this.getSetting('host');

    if (!this.client) {
      const wait = this.homey.app.connectDelay(host);
      if (wait > 0) return wait;
    }

    try {
      await this.ensureConnected(host);
      await this.readStep(CYCLE[this.cycleIndex]);
      this.cycleIndex = (this.cycleIndex + 1) % CYCLE.length;
      this.failures = 0;
      this.stats.ok += 1;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.failures += 1;
      this.stats.failed += 1;
      this.log(`Request failed (${this.failures} in a row): ${err.message}`);
      if (this.failures % FAILURES_BEFORE_RECONNECT === 0) await this.disconnect();
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE && this.getAvailable()) {
        await this.setUnavailable(this.homey.__('errors.unreachable')).catch(this.error);
      }
    }
    return this.requestInterval();
  }

  logStatus() {
    const { ok, failed } = this.stats;
    this.stats = { ok: 0, failed: 0 };
    this.log(`Last minute: ${ok} reads OK, ${failed} failed | power ${this.getCapabilityValue('measure_power')} W, `
      + `import ${this.getCapabilityValue('meter_power.imported')} kWh`);

    const unchangedFor = Date.now() - this.lastChangeAt;
    if (ok > 0 && unchangedFor > STALE_WARNING_MS && !this.staleWarned) {
      // The module keeps answering with its last decoded values when it can no longer
      // read the meter (for example a missing encryption key), so frozen values are
      // the only symptom. Show it on the device instead of displaying old numbers silently.
      this.staleWarned = true;
      this.log(`Warning: the module has returned identical values for ${Math.round(unchangedFor / 60000)} minutes.`);
      this.setWarning(this.homey.__('warnings.stale')).catch(this.error);
    }
  }

  async ensureConnected(host) {
    if (this.client && this.client.isOpen) return;

    const client = new ModbusTcpClient({ host, timeout: REQUEST_TIMEOUT_MS });
    client.on('error', (err) => this.log(`Connection error: ${err.message}`));
    client.on('close', () => {
      this.homey.app.markClosed(host);
      if (this.client === client) this.client = null;
    });

    this.client = client;
    try {
      await client.connect();
      this.log(`Connected to ${host}:502`);
    } catch (err) {
      this.client = null;
      this.homey.app.markClosed(host);
      throw err;
    }
  }

  async disconnect() {
    const { client } = this;
    this.client = null;
    if (client) await client.close();
  }

  // --- reading and publishing values ---------------------------------------

  async readStep(step) {
    const block = BLOCKS[step];
    const buf = await this.client.readHoldingRegisters(block.start, block.count);

    if (step === 'power') {
      await this.setIfChanged('measure_power', decodePower(buf));
    } else if (step === 'phases') {
      await this.publishPhases(decodePhases(buf));
    } else if (step === 'energy') {
      await this.publishEnergy(decodeEnergy(buf));
    }
  }

  async publishPhases({ voltage, current }) {
    const previous = PHASES.map((p) => this.getCapabilityValue(`measure_current.${p}`));

    for (const [i, p] of PHASES.entries()) {
      await this.setIfChanged(`measure_voltage.${p}`, voltage[i]);
      await this.setIfChanged(`measure_current.${p}`, current[i]);
    }

    const highest = Math.max(...current);
    if (current.some((value, i) => value !== previous[i])) {
      this.phaseCurrentsChanged.trigger(this, {
        l1: current[0], l2: current[1], l3: current[2], highest,
      }).catch(this.error);
    }
    if (previous.every((value) => typeof value === 'number')) {
      this.phaseCurrentRoseAbove.trigger(this, { current: highest }, { previous, current })
        .catch(this.error);
    }
  }

  async publishEnergy({ imported, exported }) {
    // Meter readings only ever increase. A lower value means a bad read, and
    // passing it on would corrupt Homey Energy's statistics.
    const oldImported = this.getCapabilityValue('meter_power.imported');
    const oldExported = this.getCapabilityValue('meter_power.exported');
    if ((oldImported !== null && imported < oldImported) || (oldExported !== null && exported < oldExported)) {
      this.log(`Ignoring decreasing meter reading (import ${imported}, export ${exported})`);
      return;
    }
    await this.setIfChanged('meter_power.imported', imported);
    await this.setIfChanged('meter_power.exported', exported);
  }

  async setIfChanged(capability, value) {
    if (this.getCapabilityValue(capability) !== value) {
      await this.setCapabilityValue(capability, value);
      this.lastChangeAt = Date.now();
      if (this.staleWarned) {
        this.staleWarned = false;
        this.log('Values are changing again.');
        this.unsetWarning().catch(this.error);
      }
    }
  }

  // --- lifecycle -------------------------------------------------------------

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('host') && !this.driver.isValidHost(newSettings.host)) {
      throw new Error(this.homey.__('errors.invalid_ip'));
    }
    if (changedKeys.includes('host')) {
      // Reconnect once the new settings are saved.
      this.homey.setTimeout(() => {
        this.log(`Module address changed to ${this.getSetting('host')}`);
        this.failures = 0;
        this.disconnect().catch(this.error);
        this.schedule(0);
      }, 500);
    }
  }

  async onUninit() {
    await this.stop();
  }

  async onDeleted() {
    await this.stop();
  }

  async stop() {
    this.stopped = true;
    if (this.statusTimer) this.homey.clearInterval(this.statusTimer);
    if (this.timer) this.homey.clearTimeout(this.timer);
    this.timer = null;
    await this.disconnect().catch(this.error);
  }

}

module.exports = KamstrupDevice;
