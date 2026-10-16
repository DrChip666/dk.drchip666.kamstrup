'use strict';

/*
 * Register map of the smart-me Kamstrup module (Modbus TCP, unit id 1, function 03).
 * Addresses are protocol addresses. Every value is 32 bits spread over two registers,
 * high word first. Map and timing were measured by Ronni Hostrup for the MIT-licensed
 * homeassistant-smartme-han integration, and confirmed against a live module.
 */

const BLOCKS = {
  power: { start: 8195, count: 2 },
  phases: { start: 8211, count: 12 },
  energy: { start: 8267, count: 4 },
};

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

function decodePower(buf) {
  // Signed: negative while exporting to the grid.
  return buf.readInt32BE(0);
}

function decodePhases(buf) {
  return {
    voltage: [0, 1, 2].map((i) => round(buf.readUInt32BE(i * 4) * 0.001, 1)),
    current: [0, 1, 2].map((i) => round(buf.readUInt32BE(12 + i * 4) * 0.01, 2)),
  };
}

function decodeEnergy(buf) {
  return {
    imported: round(buf.readUInt32BE(0) * 0.001, 3),
    exported: round(buf.readUInt32BE(4) * 0.001, 3),
  };
}

module.exports = {
  BLOCKS, decodePower, decodePhases, decodeEnergy,
};
