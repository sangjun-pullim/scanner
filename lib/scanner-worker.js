/**
 * Worker thread entry for scanner DLL calls
 * - Runs all koffi/DLL calls off the Electron main thread to avoid UI freezes
 */

const { parentPort } = require('worker_threads');

const Scanner = require('./scanner');

let scanner = null;

function ensureScanner() {
  if (!scanner) scanner = new Scanner();
  return scanner;
}

async function handleMessage(msg) {
  const { id, cmd, args } = msg || {};

  try {
    const s = ensureScanner();

    switch (cmd) {
      case 'init': {
        const ok = s.init();
        return { ok };
      }
      case 'open': {
        const hwnd = args?.hwnd || null;
        const ok = s.open(hwnd);
        return { ok, opened: s.opened };
      }
      case 'close': {
        s.close();
        return { ok: true, opened: s.opened };
      }
      case 'scanAuto': {
        const outputPath = args?.outputPath;
        const r = s.scanAuto(outputPath);
        return { ...r };
      }
      case 'scanCardWithType': {
        const outputPath = args?.outputPath;
        const nType = args?.nType;
        const code = s.scanCardWithType(outputPath, nType);
        return { code };
      }
      case 'getDocumentType': {
        const r = s.getDocumentType();
        return { value: r };
      }
      case 'readMRZ': {
        const r = s.readMRZ();
        return { value: r };
      }
      case 'readIDCard': {
        const r = s.readIDCard();
        return { value: r };
      }
      case 'readDriverLicense': {
        const r = s.readDriverLicense();
        return { value: r };
      }
      case 'readAlienCard': {
        const r = s.readAlienCard();
        return { value: r };
      }
      case 'getSensorValue': {
        const r = s.getSensorValue();
        return { value: r };
      }
      case 'detectDocumentType': {
        const r = s.detectDocumentType();
        return { value: r };
      }
      case 'resetState': {
        s.resetState();
        return { ok: true };
      }
      case 'opened': {
        return { opened: s.opened };
      }
      default:
        throw new Error(`Unknown cmd: ${cmd}`);
    }
  } catch (err) {
    return { __error: true, message: err?.message || String(err), stack: err?.stack };
  }
}

parentPort.on('message', async (msg) => {
  const id = msg?.id;
  const res = await handleMessage(msg);
  parentPort.postMessage({ id, ...res });
});
