/**
 * Scanner client that proxies all DLL calls to a dedicated worker thread.
 */

const path = require('path');
const { Worker } = require('worker_threads');

class ScannerClient {
  constructor() {
    this._reqId = 1;
    this._pending = new Map();
    this._opened = false;

    const workerPath = path.join(__dirname, 'scanner-worker.js');
    this._worker = new Worker(workerPath);

    this._worker.on('message', (msg) => {
      const { id } = msg || {};
      const p = this._pending.get(id);
      if (!p) return;
      this._pending.delete(id);

      if (msg && msg.__error) {
        const e = new Error(msg.message || 'Worker error');
        e.stack = msg.stack || e.stack;
        p.reject(e);
        return;
      }

      if (typeof msg.opened === 'boolean') {
        this._opened = msg.opened;
      }

      p.resolve(msg);
    });

    this._worker.on('error', (err) => {
      // Fail all pending requests
      for (const [, p] of this._pending) p.reject(err);
      this._pending.clear();
    });

    this._worker.on('exit', (code) => {
      if (code === 0) return;
      const err = new Error(`Scanner worker exited with code ${code}`);
      for (const [, p] of this._pending) p.reject(err);
      this._pending.clear();
    });
  }

  _call(cmd, args) {
    const id = this._reqId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, cmd, args });
    });
  }

  async init() {
    const r = await this._call('init');
    return !!r.ok;
  }

  async open(hwnd) {
    const r = await this._call('open', { hwnd });
    this._opened = !!r.ok;
    return !!r.ok;
  }

  async close() {
    await this._call('close');
    this._opened = false;
  }

  async scanAuto(outputPath) {
    const r = await this._call('scanAuto', { outputPath });
    return { success: !!r.success, type: r.type, cardType: r.cardType };
  }

  async scanCardWithType(outputPath, nType) {
    const r = await this._call('scanCardWithType', { outputPath, nType });
    return r.code;
  }

  async getDocumentType() {
    const r = await this._call('getDocumentType');
    return r.value;
  }

  async readMRZ() {
    const r = await this._call('readMRZ');
    return r.value;
  }

  async readIDCard() {
    const r = await this._call('readIDCard');
    return r.value;
  }

  async readDriverLicense() {
    const r = await this._call('readDriverLicense');
    return r.value;
  }

  async readAlienCard() {
    const r = await this._call('readAlienCard');
    return r.value;
  }

  get opened() {
    return this._opened;
  }

  async destroy() {
    try {
      await this.close();
    } catch (_) {}
    if (this._worker) {
      await this._worker.terminate();
    }
  }
}

module.exports = ScannerClient;
