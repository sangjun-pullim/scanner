/**
 * Electron Main Process
 * 여권/신분증 자동 스캔 앱
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ScannerClient = require('./lib/scanner-client');
const UsbMonitor = require('./lib/usb-monitor');
const { extractPassportNo, parseMrzFull } = require('./lib/mrz-parser');

// 설정
const SAVE_FOLDER = 'C:\\passport-scan';
const SCAN_INTERVAL = 500; // 스캔 시도 간격 (ms) - 너무 빠르면 CPU 부하
const FAIL_BACKOFF_MS = 2500; // 인식 실패 시 다음 시도까지 대기 (ms)

// 전역 변수
let mainWindow = null;
let scanner = null;
let scannerOpened = false;
let usbMonitor = null;
let scanLoopTimer = null;
let isScanning = false;
let lastFailedAt = 0;

function withTimeout(promise, ms, label = 'operation') {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

/**
 * 메인 윈도우 생성
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 개발 중에는 DevTools 열기
  // mainWindow.webContents.openDevTools();
}

/**
 * 저장 폴더 생성
 */
function ensureSaveFolder() {
  try {
    if (!fs.existsSync(SAVE_FOLDER)) {
      fs.mkdirSync(SAVE_FOLDER, { recursive: true });
    }
    console.log('[App] Save folder ready:', SAVE_FOLDER);
  } catch (err) {
    console.error('[App] Failed to create save folder:', err.message);
  }
}

/**
 * 스캐너 초기화
 */
async function initScanner() {
  scanner = new ScannerClient();

  const ok = await scanner.init();
  if (!ok) {
    console.error('[App] Failed to initialize scanner DLL');
    sendToRenderer('scanner-status', { connected: false, error: 'DLL 로드 실패' });
    return false;
  }

  return true;
}

/**
 * 스캐너 장치 열기 시도
 */
async function tryOpenDevice() {
  if (!scanner) return false;
  
  // Electron 윈도우 핸들 획득
  let hwnd = null;
  if (mainWindow) {
    try {
      hwnd = mainWindow.getNativeWindowHandle();
    } catch (err) {
      console.warn('[App] Could not get native window handle');
    }
  }
  
  // Open이 오래 걸리면 UI(렌더러)가 reconnect await에서 멈춰버리므로 타임아웃 적용
  const success = await withTimeout(scanner.open(hwnd), 3000, 'scanner.open').catch(() => false);
  scannerOpened = success;
  sendToRenderer('scanner-status', { connected: success });
  
  return success;
}

/**
 * 스캐너 장치 닫기
 */
async function closeDevice() {
  if (scanner) {
    try {
      await withTimeout(scanner.close(), 2000, 'scanner.close');
    } catch (_) {
      // best-effort
    }
    scannerOpened = false;
    sendToRenderer('scanner-status', { connected: false });
  }
}

/**
 * USB 모니터링 시작
 */
function startUsbMonitoring() {
  usbMonitor = new UsbMonitor({
    // 장치 확인 콜백 (폴링 방식)
    checkDevice: () => {
      return !!scannerOpened;
    }
  });
  
  usbMonitor.on('connected', () => {
    console.log('[App] USB device connected, trying to open...');
    setTimeout(() => { tryOpenDevice().catch(() => {}); }, 500);
  });
  
  usbMonitor.on('disconnected', () => {
    console.log('[App] USB device disconnected');
    closeDevice().catch(() => {});
  });
  
  // 초기 연결 시도
  tryOpenDevice().catch(() => {});
  
  // 폴링 모니터링은 장치 연결 안 됐을 때만 사용
  // (DLL 자체가 장치 상태 관리하므로)
}

/**
 * 자동 스캔 루프 시작
 */
function startScanLoop() {
  if (scanLoopTimer) return;
  
  console.log('[App] Scan loop started');
  
  scanLoopTimer = setInterval(() => {
    if (!scanner || !scannerOpened || isScanning) return;
    if (Date.now() - lastFailedAt < FAIL_BACKOFF_MS) return;
    
    // async 함수 에러 처리
    performScan().catch(err => {
      console.error('[App] Scan loop error:', err.message);
      isScanning = false;
    });
  }, SCAN_INTERVAL);
}

/**
 * 자동 스캔 루프 중지
 */
function stopScanLoop() {
  if (scanLoopTimer) {
    clearInterval(scanLoopTimer);
    scanLoopTimer = null;
    console.log('[App] Scan loop stopped');
  }
}

/**
 * 스캔 수행
 */
// 딜레이 함수
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function writeUtf8BomFileSync(filePath, content) {
  // Windows 기본 메모장/일부 뷰어에서 깨짐 방지를 위해 BOM 포함
  const text = content == null ? '' : String(content);
  fs.writeFileSync(filePath, '\ufeff' + text, 'utf8');
}

async function waitForFileExists(filePath, timeoutMs = 6000, intervalMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await sleep(intervalMs);
  }
  return fs.existsSync(filePath);
}

function uniqueFilePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  let candidate = path.join(dir, fileName);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_${i}${ext}`);
    i++;
  }
  return candidate;
}

function isValidPassportMRZ(mrz) {
  if (!mrz || typeof mrz !== 'string') return false;
  // TD3(여권) MRZ는 보통 'P' 또는 'P<'로 시작하고, 최소 2줄(또는 88자 연결)이 필요
  // 스캐너가 개행을 빼고 줄여서 주는 경우도 있어 길이 기준을 넉넉히 둠
  const cleaned = mrz.replace(/\s/g, '');
  return (cleaned.startsWith('P') || cleaned.startsWith('P<')) && cleaned.length >= 60;
}

function isValidOCRString(str) {
  if (!str || typeof str !== 'string') return false;
  // null/제어문자 포함이면 무효
  if (/[\x00-\x1F]/.test(str)) return false;
  return str.trim().length >= 2;
}

function looksLikeKoreanRRN(idNo) {
  if (!idNo) return false;
  const s = String(idNo).trim();
  return /^\d{6}-\d{7}$/.test(s) || /^\d{13}$/.test(s);
}

function looksLikeDriverLicenseNo(licenseNo) {
  if (!licenseNo) return false;
  const s = String(licenseNo).trim();
  // 예: 11-17-003817-30
  return /^\d{2}-\d{2}-\d{6}-\d{2}$/.test(s);
}

function looksLikeAlienRegNo(alienNo) {
  if (!alienNo) return false;
  const s = String(alienNo).trim();
  // 외국인등록번호: YYMMDD-XXXXXXX (뒷자리 첫 숫자 5,6,7,8)
  // 하이픈 포함 14자리
  if (/^\d{6}-[5-8]\d{6}$/.test(s)) return true;
  // 하이픈 없이 13자리
  if (/^\d{13}$/.test(s) && ['5', '6', '7', '8'].includes(s[6])) return true;
  return false;
}

async function performScan() {
  if (isScanning) return;
  isScanning = true;
  
  try {
    // .NET과 동일한 형식: yyyyMMdd_HHmmss
    const now = new Date();
    const timestamp = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    // 스캔 임시 파일명이 초 단위면(500ms 루프) 이전 스캔과 충돌/재사용될 수 있어 ms를 포함해 유니크하게 만든다.
    const ms0 = String(now.getMilliseconds()).padStart(3, '0');
    const scanStamp = `${timestamp}_${ms0}`;
    const tempBase = path.join(SAVE_FOLDER, scanStamp);
    
    // 스캔 시도 (여권 + 카드 자동 감지)
    const scanResult = await scanner.scanAuto(tempBase);
    
    if (scanResult.success) {
      console.log('[App] Scan type:', scanResult.type);
      if (scanResult.type === 'card' && typeof scanResult.cardType === 'number') {
        console.log('[App] Card scan mode (nType): 0x' + scanResult.cardType.toString(16));
      }
      // 스캔 결과 파일이 실제로 생성될 때까지 먼저 대기 (OCR/MRZ는 저장 완료 후에 안정적)
      let expectedBmp = scanStamp + '.bmp';
      let expectedIR = scanStamp + '_IR.bmp';
      let expectedBmpPath = path.join(SAVE_FOLDER, expectedBmp);
      let expectedIRPath = path.join(SAVE_FOLDER, expectedIR);

      console.log('[App] Looking for:', expectedBmp);
      const bmpReady = await waitForFileExists(expectedBmpPath, 8000, 250);
      if (!bmpReady) {
        console.log('[App] WARNING: BMP not ready in time:', expectedBmpPath);
      }
      // IR은 옵션
      await waitForFileExists(expectedIRPath, 1500, 250);

      // 파일 생성 후 OCR/MRZ 상태가 반영될 시간을 조금 더 줌
      await sleep(600);

      // 문서 종류 확인
      const docType = await scanner.getDocumentType();
      console.log('[App] Document type:', docType?.type, docType?.name || 'UNKNOWN');

      let documentId = `UNKNOWN_${Date.now()}`;
      let documentData = null;
      let mrzText = '';

      // 1) MRZ는 여권 스캔에서만 시도
      // - 카드 스캔에서 MRZ를 매번 시도하면 Leptonica(TIFF) 에러가 반복되고,
      //   일부 환경에서 이후 OCR 버퍼가 계속 0으로 남는(계속 실패처럼 보이는) 현상이 생길 수 있다.
      let isPassportConfirmed = false;
      if (scanResult.type === 'passport') {
        for (let i = 0; i < 10; i++) {
          const candidate = (await scanner.readMRZ()) || '';
          if (candidate) console.log('[App] Raw MRZ:', candidate);
          if (isValidPassportMRZ(candidate)) {
            mrzText = candidate;
            console.log('[App] Valid passport MRZ detected');
            const passportNo = extractPassportNo(mrzText);
            if (passportNo) documentId = passportNo;
            documentData = parseMrzFull(mrzText);
            if (documentData) documentData.documentType = 'PASSPORT';
            isPassportConfirmed = true;
            break;
          }
          await sleep(300);
        }
      }
      
      // 2) 카드 스캔 모드인 경우에만 OCR을 "재시도"하며 읽기
      //    (여권 모드에서 OCR 결과는 이전 스캔 캐시일 가능성이 높음)
      if ((!documentData || !documentData.documentType) && scanResult.type === 'card' && !isPassportConfirmed) {
        for (let i = 0; i < 10; i++) {
          const license = await scanner.readDriverLicense();
          const idCard = await scanner.readIDCard();
          const alien = await scanner.readAlienCard();
          console.log('[App] Driver License OCR:', license);
          console.log('[App] ID Card OCR:', idCard);
          console.log('[App] Alien Card OCR:', alien);

          // 주민등록증은 주민번호 패턴이 나오면 최우선
          if (looksLikeKoreanRRN(idCard?.idNo)) {
            documentId = String(idCard.idNo).replace(/-/g, '').substring(0, 6);
            documentData = { ...idCard, documentType: 'ID_CARD' };
            break;
          }

          // 운전면허는 면허번호 형식이 맞을 때만 채택 (주민등록증에서 직전 면허값 재사용 방지)
          if (looksLikeDriverLicenseNo(license?.licenseNo)) {
            documentId = license.licenseNo.replace(/-/g, '');
            documentData = { ...license, documentType: 'DRIVER_LICENSE' };
            break;
          }

          // 외국인등록증은 등록번호 형식이 맞을 때만 채택
          if (looksLikeAlienRegNo(alien?.alienNo)) {
            documentId = alien.alienNo.replace(/-/g, '').substring(0, 6);
            documentData = { ...alien, documentType: 'ALIEN_CARD' };
            break;
          }

          await sleep(250);
        }

        // NOTE: "OCR empty → nType 바꿔 재스캔"은 현장 로그 기준 효과가 없고(성공 사례 없음),
        // 오히려 시간/불안정만 증가하여 제거함.
      }

      // 인식 여부 최종 판단: MRZ(여권) 또는 OCR(카드) 중 하나라도 있어야 "성공"
      const recognized = (mrzText && mrzText.length > 10) || (documentData && documentData.documentType);
      if (!recognized) {
        lastFailedAt = Date.now();
        // 자동 스캔 루프가 빈 문서/오인식을 계속 찍는 걸 막기 위해
        // 파일을 저장/알림하지 않고 조용히 실패 처리
        try { if (fs.existsSync(expectedBmpPath)) fs.unlinkSync(expectedBmpPath); } catch (_) {}
        try { if (fs.existsSync(expectedIRPath)) fs.unlinkSync(expectedIRPath); } catch (_) {}
        console.log('[App] Recognition failed - skipping save/notify (backoff applied)');
        isScanning = false;
        return;
      }
      
      const parsedMrz = documentData;
      
      // documentId 검증 - null 바이트, 특수문자 제거
      documentId = documentId.replace(/[\x00-\x1F\x7F<>:"/\\|?*]/g, '').trim();
      if (!documentId || documentId.length < 2) {
        documentId = `UNKNOWN_${Date.now()}`;
      }
      
      // 파일명 충돌 방지: 스캔 시작 시각(초 포함) + ms 포함
      const now2 = new Date();
      const ms = String(now2.getMilliseconds()).padStart(3, '0');
      const fileTimestamp = formatFileTimestamp(now2);
      const baseFileName = `${documentId}_${fileTimestamp}_${ms}`;
      
      const newFiles = [];
      if (fs.existsSync(expectedBmpPath)) {
        newFiles.push(expectedBmp);
      }
      if (fs.existsSync(expectedIRPath)) {
        newFiles.push(expectedIR);
      }
      
      console.log('[App] Found BMP files:', newFiles);
      
      let savedImages = [];
      
      if (newFiles.length > 0) {
        // 새 파일들을 여권번호 기반으로 이름 변경
        newFiles.forEach((file, idx) => {
          const srcPath = path.join(SAVE_FOLDER, file);
          const suffix = file.includes('_IR') ? '_IR' : (idx > 0 ? `_${idx}` : '');
          const destName = `${baseFileName}${suffix}.bmp`;
          const destPath = uniqueFilePath(SAVE_FOLDER, destName);
          
          fs.renameSync(srcPath, destPath);
          savedImages.push(destPath);
          console.log('[App] Renamed:', file, '->', path.basename(destPath));
        });
      } else {
        console.log('[App] WARNING: No new image files found!');
      }
      
      // 텍스트 파일 저장 (문서 종류별로 다르게)
      const txtPath = uniqueFilePath(SAVE_FOLDER, `${baseFileName}.txt`);
      let textContent = '';
      
      // 1. 여권 MRZ가 있으면 MRZ 저장
      if (mrzText && mrzText.length > 10) {
        textContent = mrzText;
      }
      // 2. OCR 결과가 있으면 OCR 결과 저장 (신분증/면허증/외국인등록증)
      else if (documentData && documentData.documentType) {
        const lines = [];
        lines.push(`[${documentData.documentType}]`);
        if (documentData.name) lines.push(`이름: ${documentData.name}`);
        if (documentData.idNo) lines.push(`주민번호: ${documentData.idNo}`);
        if (documentData.licenseNo) lines.push(`면허번호: ${documentData.licenseNo}`);
        if (documentData.licenseType) lines.push(`면허종류: ${documentData.licenseType}`);
        if (documentData.validPeriod) lines.push(`적성기간: ${documentData.validPeriod}`);
        if (documentData.alienNo) lines.push(`외국인번호: ${documentData.alienNo}`);
        if (documentData.visaType) lines.push(`체류자격: ${documentData.visaType}`);
        if (documentData.area) lines.push(`지역: ${documentData.area}`);
        if (documentData.address) lines.push(`주소: ${documentData.address}`);
        if (documentData.issuedDate) lines.push(`발급일: ${documentData.issuedDate}`);
        textContent = lines.join('\n');
      }
      // 3. 아무것도 없으면 기본 메시지
      else {
        textContent = '[인식 실패]\n문서를 인식하지 못했습니다.';
      }
      
      console.log('[App] Saving text file:', textContent.substring(0, 100));
      writeUtf8BomFileSync(txtPath, textContent);
      
      // JSON 파일 저장 (파싱된 정보)
      if (documentData) {
        const jsonPath = uniqueFilePath(SAVE_FOLDER, `${baseFileName}.json`);
        writeUtf8BomFileSync(jsonPath, JSON.stringify(documentData, null, 2));
      }
      
      console.log('[App] Scan complete:', documentId, '- Type:', docType?.name, '- Images:', savedImages.length);
      
      // Renderer에 결과 전송
      sendToRenderer('scan-result', {
        ok: true,
        passportNo: documentId,
        documentId,
        documentType: docType?.name || 'UNKNOWN',
        mrz: mrzText,
        parsed: parsedMrz,
        imagePath: savedImages[0] || null,
        images: savedImages,
        timestamp: new Date().toISOString()
      });
      
      // 스캔 후 잠시 대기 (같은 문서 중복 스캔 방지)
      await sleep(1500);
      isScanning = false;
    } else {
      // 문서 없음 - 바로 다음 시도 가능
      isScanning = false;
    }
  } catch (err) {
    console.error('[App] Scan error:', err.message, err.stack);
    isScanning = false;
  }
}

/**
 * Renderer에 메시지 전송
 */
function sendToRenderer(channel, data) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, data);
  }
}

function formatFileTimestamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}_${h}-${min}-${s}`;
}

// ═══════════════════════════════════════════════════════════════════
// IPC 핸들러
// ═══════════════════════════════════════════════════════════════════

ipcMain.handle('get-status', () => {
  return {
    scannerConnected: !!scannerOpened,
    saveFolder: SAVE_FOLDER
  };
});

ipcMain.handle('manual-scan', async () => {
  if (!scanner || !scannerOpened) {
    return { ok: false, error: 'Scanner not connected' };
  }
  
  performScan().catch(() => {});
  return { ok: true };
});

ipcMain.handle('reconnect-scanner', async () => {
  // 1) 기존 연결 닫기(완료될 때까지 대기)
  await closeDevice().catch(() => {});
  // 장치/드라이버 정리 시간 약간 부여
  await sleep(250);

  // 2) 빠른 재연결 시도 (짧은 타임아웃)
  let success = await tryOpenDevice().catch(() => false);
  if (success) return { ok: true };

  // 3) 여전히 실패/지연이면 워커 자체를 재시작(걸린 호출을 끊기 위해)
  try {
    if (scanner && typeof scanner.destroy === 'function') {
      await withTimeout(scanner.destroy(), 1500, 'scanner.destroy');
    }
  } catch (_) {}

  // 새 워커/클라이언트 생성 후 재시도
  scanner = new ScannerClient();
  const inited = await withTimeout(scanner.init(), 3000, 'scanner.init').catch(() => false);
  if (!inited) {
    scannerOpened = false;
    sendToRenderer('scanner-status', { connected: false, error: 'DLL 로드 실패' });
    return { ok: false, error: 'init failed' };
  }

  success = await tryOpenDevice().catch(() => false);
  return { ok: success };
});

ipcMain.handle('start-scan-loop', () => {
  if (!scanner || !scannerOpened) {
    return { ok: false, error: 'Scanner not connected' };
  }
  startScanLoop();
  return { ok: true, message: 'Scan loop started' };
});

ipcMain.handle('stop-scan-loop', () => {
  stopScanLoop();
  return { ok: true, message: 'Scan loop stopped' };
});

ipcMain.handle('get-scan-loop-status', () => {
  return {
    running: scanLoopTimer !== null,
    scannerConnected: !!scannerOpened
  };
});

// ═══════════════════════════════════════════════════════════════════
// App 이벤트
// ═══════════════════════════════════════════════════════════════════

app.whenReady().then(async () => {
  ensureSaveFolder();
  createWindow();
  
  if (await initScanner()) {
    startUsbMonitoring();
    startScanLoop();
  }
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopScanLoop();
  closeDevice().catch(() => {});
  
  if (usbMonitor) {
    usbMonitor.stop();
  }

  if (scanner && typeof scanner.destroy === 'function') {
    scanner.destroy().catch(() => {});
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopScanLoop();
  closeDevice().catch(() => {});

  if (scanner && typeof scanner.destroy === 'function') {
    // best-effort termination
    scanner.destroy().catch(() => {});
  }
});
