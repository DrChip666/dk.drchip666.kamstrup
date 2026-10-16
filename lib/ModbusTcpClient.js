'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const FC_READ_HOLDING_REGISTERS = 0x03;
const MBAP_HEADER_LENGTH = 7; // transaction id (2) + protocol id (2) + length (2) + unit id (1)

const EXCEPTION_MESSAGES = {
  1: 'illegal function',
  2: 'illegal data address',
  3: 'illegal data value',
  4: 'server device failure',
  6: 'server device busy',
};

class ModbusError extends Error {

  constructor(message, code) {
    super(message);
    this.name = 'ModbusError';
    this.code = code;
  }

}

/**
 * Minimal Modbus TCP client that only implements "Read Holding Registers" (0x03),
 * which is all the smart-me module supports. One request is in flight at a time.
 *
 * Responses that arrive after their request timed out carry an old transaction id
 * and are ignored, so a late answer can never be mistaken for a newer request.
 */
class ModbusTcpClient extends EventEmitter {

  constructor({
    host, port = 502, unitId = 1, timeout = 3000,
  }) {
    super();
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.timeout = timeout;

    this._socket = null;
    this._buffer = Buffer.alloc(0);
    this._transactionId = 0;
    this._pending = null;
  }

  get isOpen() {
    return this._socket !== null && !this._socket.destroyed && !this._socket.connecting;
  }

  connect() {
    if (this._socket) return Promise.reject(new ModbusError('Already connected or connecting', 'EALREADY'));

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this._socket = socket;
      socket.setNoDelay(true);

      const timer = setTimeout(() => {
        socket.destroy(new ModbusError(`Connection to ${this.host}:${this.port} timed out`, 'ETIMEDOUT'));
      }, this.timeout);

      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });

      socket.on('data', (chunk) => this._onData(chunk));

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err); // no-op once connected
        this.emit('error', err);
      });

      socket.on('close', () => {
        clearTimeout(timer);
        this._socket = null;
        this._buffer = Buffer.alloc(0);
        this._rejectPending(new ModbusError('Connection closed', 'ECLOSED'));
        this.emit('close');
      });
    });
  }

  close() {
    if (!this._socket) return Promise.resolve();
    const socket = this._socket;
    return new Promise((resolve) => {
      socket.once('close', resolve);
      socket.destroy();
    });
  }

  /**
   * Read `count` holding registers starting at protocol address `start`.
   * Resolves with a Buffer of count * 2 bytes (big-endian register values).
   */
  readHoldingRegisters(start, count) {
    if (!this.isOpen) return Promise.reject(new ModbusError('Not connected', 'ENOTCONN'));
    if (this._pending) return Promise.reject(new ModbusError('A request is already in flight', 'EBUSY'));

    this._transactionId = (this._transactionId + 1) & 0xffff;
    const transactionId = this._transactionId;

    const frame = Buffer.alloc(12);
    frame.writeUInt16BE(transactionId, 0);
    frame.writeUInt16BE(0, 2); // protocol id: Modbus
    frame.writeUInt16BE(6, 4); // bytes that follow: unit id + PDU
    frame.writeUInt8(this.unitId, 6);
    frame.writeUInt8(FC_READ_HOLDING_REGISTERS, 7);
    frame.writeUInt16BE(start, 8);
    frame.writeUInt16BE(count, 10);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending && this._pending.transactionId === transactionId) {
          this._pending = null;
          reject(new ModbusError(`No answer for register ${start} within ${this.timeout} ms`, 'ETIMEDOUT'));
        }
      }, this.timeout);

      this._pending = {
        transactionId, start, count, resolve, reject, timer,
      };
      this._socket.write(frame);
    });
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    while (this._buffer.length >= MBAP_HEADER_LENGTH) {
      const length = this._buffer.readUInt16BE(4);
      const frameLength = 6 + length;
      if (length < 2 || length > 254) {
        // Not a valid Modbus frame: drop everything and let the caller time out and reconnect.
        this._buffer = Buffer.alloc(0);
        return;
      }
      if (this._buffer.length < frameLength) return;

      const frame = this._buffer.subarray(0, frameLength);
      this._buffer = this._buffer.subarray(frameLength);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    const pending = this._pending;
    const transactionId = frame.readUInt16BE(0);
    if (!pending || pending.transactionId !== transactionId) return; // stale or unsolicited

    this._pending = null;
    clearTimeout(pending.timer);

    const functionCode = frame.readUInt8(7);
    if (functionCode === (FC_READ_HOLDING_REGISTERS | 0x80)) {
      const code = frame.readUInt8(8);
      const text = EXCEPTION_MESSAGES[code] || `exception ${code}`;
      pending.reject(new ModbusError(`Modbus ${text} at register ${pending.start}`, `EXCEPTION_${code}`));
      return;
    }
    if (functionCode !== FC_READ_HOLDING_REGISTERS) {
      pending.reject(new ModbusError(`Unexpected function code ${functionCode}`, 'EPROTO'));
      return;
    }

    const byteCount = frame.readUInt8(8);
    const data = frame.subarray(9, 9 + byteCount);
    if (byteCount !== pending.count * 2 || data.length !== byteCount) {
      pending.reject(new ModbusError(`Expected ${pending.count * 2} bytes, got ${data.length}`, 'EPROTO'));
      return;
    }
    pending.resolve(Buffer.from(data));
  }

  _rejectPending(err) {
    if (!this._pending) return;
    const pending = this._pending;
    this._pending = null;
    clearTimeout(pending.timer);
    pending.reject(err);
  }

}

module.exports = { ModbusTcpClient, ModbusError };
