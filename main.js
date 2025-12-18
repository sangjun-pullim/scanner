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
let pendingManualScan = false;
let lastReconnectAt = 0;
let consecutiveScanAutoTimeouts = 0;

async function forceReconnectScanner(reason = 'unknown') {
  // reconnect storm 방지 (예: scanAuto가 계속 timeout이면 0.5초마다 재연결이 연쇄 발생)
  const now = Date.now();
  if (now - lastReconnectAt < 3000) {
    console.warn('[App] Reconnect suppressed (too frequent):', reason);
    return false;
  }
  lastReconnectAt = now;

  console.warn('[App] Force reconnect scanner:', reason);
  // reconnect 동안 scan loop가 다시 스캔을 시도하면 상태가 꼬일 수 있으니 잠시 중지
  const wasRunning = !!scanLoopTimer;
  stopScanLoop();
  // 1) 기존 연결 닫기(완료될 때까지 대기)
  await closeDevice().catch(() => {});
  // 장치/드라이버 정리 시간 약간 부여
  await sleep(250);

  // 2) 워커 자체를 재시작(걸린 호출을 끊기 위해)
  try {
    if (scanner && typeof scanner.destroy === 'function') {
      await withTimeout(scanner.destroy(), 1500, 'scanner.destroy');
    }
  } catch (_) {}

  // 3) 새 워커/클라이언트 생성 후 재시도
  scanner = new ScannerClient();
  const inited = await withTimeout(scanner.init(), 3000, 'scanner.init').catch(() => false);
  if (!inited) {
    scannerOpened = false;
    sendToRenderer('scanner-status', { connected: false, error: 'DLL 로드 실패' });
    return false;
  }

  const success = await tryOpenDevice().catch(() => false);
  if (success && wasRunning) startScanLoop();
  return !!success;
}

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

function isLikelyValidOcr(documentData) {
  if (!documentData || !documentData.documentType) return false;

  if (documentData.documentType === 'ID_CARD') {
    // 주민번호가 가장 신뢰도 높음. 일부 케이스에서는 name만 먼저 나오는 경우가 있어 최소 기준 완화
    return looksLikeKoreanRRN(documentData.idNo) || (String(documentData.name || '').trim().length >= 2);
  }
  if (documentData.documentType === 'DRIVER_LICENSE') {
    return looksLikeDriverLicenseNo(documentData.licenseNo) || (String(documentData.name || '').trim().length >= 2);
  }
  if (documentData.documentType === 'ALIEN_CARD') {
    return looksLikeAlienRegNo(documentData.alienNo) || (String(documentData.name || '').trim().length >= 2);
  }
  if (documentData.documentType === 'PASSPORT') {
    return true;
  }
  return false;
}

function sanitizeFileComponent(s) {
  return String(s || '')
    .replace(/[\x00-\x1F\x7F<>:"/\\|?*]/g, '')
    .trim();
}

function normalizeYyyyMmDd(input) {
  // 목표 포맷: YYYYMMDD
  // 입력 예:
  // - 2011.8.10.
  // - 2017.01.16.
  // - 2027.12.31.
  // - 2027-12-31
  // - 2027-12-31_... (일부 섞임)
  // - "~2027.12.8" / ":~2027.12.8" 등
  if (input == null) return '';
  const s = String(input).trim();
  if (!s) return '';

  // YYYYMMDD가 이미 들어있는 경우 (최초 8자리)
  const compact = s.replace(/[^\d]/g, '');
  if (/^\d{8}/.test(compact)) return compact.slice(0, 8);

  // 구분자 기반 YYYY[.-/]M[.-/]D
  const m = s.match(/(19\d{2}|20\d{2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/);
  if (!m) return '';
  const yyyy = m[1];
  const mm = String(parseInt(m[2], 10)).padStart(2, '0');
  const dd = String(parseInt(m[3], 10)).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function normalizeDateLikeRange(input) {
  // 운전면허 적성기간(validPeriod) 같은 값이 "~2027.12.8" / "2020.1.1~2027.12.8" 형태일 수 있어
  // 단일/범위 모두 YYYYMMDD(또는 YYYYMMDD~YYYYMMDD)로 정규화
  if (input == null) return '';
  const s = String(input).trim();
  if (!s) return '';

  if (s.includes('~')) {
    const parts = s.split('~').map(p => p.trim());
    const left = normalizeYyyyMmDd(parts[0]);
    const right = normalizeYyyyMmDd(parts[1]);
    if (left && right) return `${left}~${right}`;
    if (!left && right) return `~${right}`;
    if (left && !right) return `${left}~`;
    return '';
  }
  return normalizeYyyyMmDd(s);
}

function normalizeDocumentDataDates(documentData) {
  if (!documentData || typeof documentData !== 'object') return documentData;
  const docType = documentData.documentType;
  const out = { ...documentData };

  // 공통적으로 "date" 성격인 필드들을 문서별로 정규화
  if (docType === 'ID_CARD') {
    if ('issuedDate' in out) out.issuedDate = normalizeDateLikeRange(out.issuedDate);
  } else if (docType === 'DRIVER_LICENSE') {
    if ('issuedDate' in out) out.issuedDate = normalizeDateLikeRange(out.issuedDate);
    if ('validPeriod' in out) out.validPeriod = normalizeDateLikeRange(out.validPeriod);
  } else if (docType === 'ALIEN_CARD') {
    // 현재는 별도 날짜 필드 없음(필요 시 추가)
  } else if (docType === 'PASSPORT') {
    // MRZ 파서가 YYYY-MM-DD를 반환하므로 YYYYMMDD로 변환
    if ('birthDate' in out) out.birthDate = normalizeDateLikeRange(out.birthDate);
    if ('expiryDate' in out) out.expiryDate = normalizeDateLikeRange(out.expiryDate);
  }

  return out;
}

function createScanStamp(date = new Date()) {
  // .NET과 동일한 형식: yyyyMMdd_HHmmss + _ms (1초 내 연속 스캔 시 파일명 충돌 방지)
  const timestamp = date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0') + '_' +
    String(date.getHours()).padStart(2, '0') +
    String(date.getMinutes()).padStart(2, '0') +
    String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${timestamp}_${ms}`;
}

async function scanStep(tempBase) {
  // 센서 기반 자동 감지: 카드/여권 1회 스캔
  return await withTimeout(scanner.scanAuto(tempBase), 12000, 'scanner.scanAuto');
}

async function docTypeStep() {
  // C# 샘플의 QuantA6_GetType() 대응
  return await withTimeout(scanner.getDocumentType(), 1500, 'scanner.getDocumentType').catch(() => null);
}

async function docTypeStepWithRetry(maxTries = 3, delayMs = 300) {
  // GetType()는 스캔 직후/직전 실패(A스캔) 이후 잠깐 UNKNOWN을 줄 수 있어 짧게 폴링
  let last = null;
  for (let i = 0; i < maxTries; i++) {
    last = await docTypeStep();
    if (last && last.name && last.name !== 'UNKNOWN') return last;
    await sleep(delayMs);
  }
  return last;
}

async function waitImagesStep(scanStamp) {
  // scanAuto(outputBase) => outputBase.bmp, outputBase_IR.bmp 생성
  const bmpPath = path.join(SAVE_FOLDER, `${scanStamp}.bmp`);
  const irPath = path.join(SAVE_FOLDER, `${scanStamp}_IR.bmp`);

  const bmpReady = await waitForFileExists(bmpPath, 8000, 250);
  if (!bmpReady) {
    return { bmpPath: null, irPath: null };
  }
  // IR은 옵션
  await waitForFileExists(irPath, 1500, 250);
  // OCR/MRZ 값이 안정적으로 채워질 시간을 약간 부여
  await sleep(500);

  return {
    bmpPath: fs.existsSync(bmpPath) ? bmpPath : null,
    irPath: fs.existsSync(irPath) ? irPath : null
  };
}

async function mrzStep() {
  // C# 샘플의 QuantA6_ReadMRZ() 대응
  // 일부 환경에서 바로 값이 안 채워질 수 있어 짧게만 재시도
  for (let i = 0; i < 3; i++) {
    const mrz = (await withTimeout(scanner.readMRZ(), 1500, 'scanner.readMRZ').catch(() => '')) || '';
    if (isValidPassportMRZ(mrz)) return mrz;
    await sleep(250);
  }
  return '';
}

async function ocrStep(docType) {
  // C# 샘플의 type 분기 + OCR 함수 호출 대응
  const name = docType?.name || 'UNKNOWN';

  if (name === 'ID_CARD') {
    for (let i = 0; i < 4; i++) {
      const v = await withTimeout(scanner.readIDCard(), 1500, 'scanner.readIDCard').catch(() => null);
      const r = v ? { ...v, documentType: 'ID_CARD' } : null;
      if (isLikelyValidOcr(r)) return r;
      await sleep(500);
    }
    return null;
  }
  if (name === 'DRIVER_LICENSE') {
    // NOTE: 운전면허는 인식실패한 스캔 이후 첫 스캔에서 OCR 버퍼가 늦게 채워지는 케이스가 있어
    // "재스캔"을 요구하기보다 같은 스캔에 대해 OCR을 더 오래 폴링한다.
    for (let i = 0; i < 8; i++) {
      const v = await withTimeout(scanner.readDriverLicense(), 1500, 'scanner.readDriverLicense').catch(() => null);
      const r = v ? { ...v, documentType: 'DRIVER_LICENSE' } : null;
      if (isLikelyValidOcr(r)) return r;
      await sleep(800);
    }
    return null;
  }
  if (name === 'ALIEN_CARD') {
    for (let i = 0; i < 4; i++) {
      const v = await withTimeout(scanner.readAlienCard(), 1500, 'scanner.readAlienCard').catch(() => null);
      const r = v ? { ...v, documentType: 'ALIEN_CARD' } : null;
      if (isLikelyValidOcr(r)) return r;
      await sleep(500);
    }
    return null;
  }

  // UNKNOWN이면 1회씩만 호출해서 가장 그럴듯한 결과를 선택 (과한 루프/재시도 제거)
  // IMPORTANT: DLL 호출은 re-entrant가 아닐 수 있어 병렬 호출 금지 (worker thread 출력 interleave + 상태 꼬임 방지)
  for (let round = 0; round < 2; round++) {
    const idCard = await withTimeout(scanner.readIDCard(), 1500, 'scanner.readIDCard').catch(() => null);
    const idR = idCard ? { ...idCard, documentType: 'ID_CARD' } : null;
    if (isLikelyValidOcr(idR)) return idR;

    const license = await withTimeout(scanner.readDriverLicense(), 1500, 'scanner.readDriverLicense').catch(() => null);
    const licR = license ? { ...license, documentType: 'DRIVER_LICENSE' } : null;
    if (isLikelyValidOcr(licR)) return licR;

    const alien = await withTimeout(scanner.readAlienCard(), 1500, 'scanner.readAlienCard').catch(() => null);
    const alienR = alien ? { ...alien, documentType: 'ALIEN_CARD' } : null;
    if (isLikelyValidOcr(alienR)) return alienR;

    await sleep(300);
  }

  return null;
}

function deriveDocumentId(documentData, mrzText) {
  if (mrzText) {
    const passportNo = extractPassportNo(mrzText);
    if (passportNo) return passportNo;
    return 'PASSPORT';
  }

  if (!documentData) return 'UNKNOWN';

  if (documentData.documentType === 'ID_CARD' && looksLikeKoreanRRN(documentData.idNo)) {
    return String(documentData.idNo).replace(/-/g, '').substring(0, 6);
  }
  if (documentData.documentType === 'DRIVER_LICENSE' && looksLikeDriverLicenseNo(documentData.licenseNo)) {
    return String(documentData.licenseNo).replace(/-/g, '');
  }
  if (documentData.documentType === 'ALIEN_CARD' && looksLikeAlienRegNo(documentData.alienNo)) {
    return String(documentData.alienNo).replace(/-/g, '').substring(0, 6);
  }
  return documentData.documentType || 'UNKNOWN';
}

function buildTextContent({ mrzText, documentData }) {
  if (mrzText && mrzText.length > 10) return mrzText;
  if (!documentData || !documentData.documentType) return '[인식 실패]\n문서를 인식하지 못했습니다.';

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
  return lines.join('\n');
}

function renameAndSaveImages({ bmpPath, irPath }, baseFileName) {
  const savedImages = [];

  if (bmpPath && fs.existsSync(bmpPath)) {
    const destPath = uniqueFilePath(SAVE_FOLDER, `${baseFileName}.bmp`);
    fs.renameSync(bmpPath, destPath);
    savedImages.push(destPath);
  }
  if (irPath && fs.existsSync(irPath)) {
    const destPath = uniqueFilePath(SAVE_FOLDER, `${baseFileName}_IR.bmp`);
    fs.renameSync(irPath, destPath);
    savedImages.push(destPath);
  }

  return savedImages;
}

function saveResultFiles({ baseFileName, mrzText, documentData }) {
  const txtPath = uniqueFilePath(SAVE_FOLDER, `${baseFileName}.txt`);
  writeUtf8BomFileSync(txtPath, buildTextContent({ mrzText, documentData }));

  if (documentData) {
    const jsonPath = uniqueFilePath(SAVE_FOLDER, `${baseFileName}.json`);
    writeUtf8BomFileSync(jsonPath, JSON.stringify(documentData, null, 2));
  }
}

async function performScan() {
  if (isScanning) return;
  isScanning = true;

  try {
    const scanStamp = createScanStamp(new Date());
    const tempBase = path.join(SAVE_FOLDER, scanStamp);

    console.log('[App] Step: scan');
    const scanResult = await scanStep(tempBase);
    if (!scanResult?.success) return; // 문서 없음
    // 스캔이 정상 진행되면 timeout 누적 카운터는 리셋
    consecutiveScanAutoTimeouts = 0;

    console.log('[App] Step: wait images');
    const images = await waitImagesStep(scanStamp);
    if (!images.bmpPath) {
      console.warn('[App] BMP not ready in time - skipping this scan');
      lastFailedAt = Date.now();
      return;
    }

    console.log('[App] Step: detect document type');
    const docType = await docTypeStepWithRetry(3, 300);
    console.log('[App] Document type:', docType?.type, docType?.name || 'UNKNOWN');

    console.log('[App] Step: OCR/MRZ');
    let mrzText = '';
    let documentData = null;

    // 카드 스캔인데 문서 타입이 끝까지 UNKNOWN이면, OCR getter들을 마구 호출하지 않는다.
    // (A스캔처럼 실패 케이스에서 DLL 내부 OCR 상태가 꼬여 다음 스캔(특히 운전면허)에 영향 주는 현상 방지)
    if (scanResult.type === 'card' && (!docType || docType.name === 'UNKNOWN')) {
      lastFailedAt = Date.now();
      try { if (images.bmpPath && fs.existsSync(images.bmpPath)) fs.unlinkSync(images.bmpPath); } catch (_) {}
      try { if (images.irPath && fs.existsSync(images.irPath)) fs.unlinkSync(images.irPath); } catch (_) {}
      try { await withTimeout(scanner.resetState(), 800, 'scanner.resetState'); } catch (_) {}
      console.log('[App] Document type UNKNOWN for card scan - skipping OCR to avoid state contamination');
      return;
    }

    if (docType?.name === 'PASSPORT' || scanResult.type === 'passport') {
      mrzText = await mrzStep();
      if (mrzText) {
        const parsed = parseMrzFull(mrzText);
        if (parsed) {
          parsed.documentType = 'PASSPORT';
          documentData = parsed;
        } else {
          // MRZ가 유효해 보여도 파싱 실패면 저장은 MRZ 텍스트만
          documentData = { documentType: 'PASSPORT' };
        }
      }
    } else {
      documentData = await ocrStep(docType);
    }

    const recognized = (mrzText && mrzText.length > 10) || isLikelyValidOcr(documentData);
    if (!recognized) {
      lastFailedAt = Date.now();
      // 자동 스캔 루프에서 빈 문서/오인식 파일이 쌓이지 않도록 정리
      try { if (images.bmpPath && fs.existsSync(images.bmpPath)) fs.unlinkSync(images.bmpPath); } catch (_) {}
      try { if (images.irPath && fs.existsSync(images.irPath)) fs.unlinkSync(images.irPath); } catch (_) {}
      // OCR/MRZ가 "이전 스캔 결과"를 다시 내놓는 케이스가 있어, 실패 시 내부 상태를 정리해 다음 스캔에 꼬리 안 남게 함
      try { await withTimeout(scanner.resetState(), 800, 'scanner.resetState'); } catch (_) {}
      console.log('[App] Recognition failed - skipping save/notify (backoff applied)');
      return;
    }

    // JSON 저장/렌더러 전송 전에 날짜 포맷 정규화 (YYYYMMDD)
    documentData = normalizeDocumentDataDates(documentData);

    console.log('[App] Step: save files');
    let documentId = deriveDocumentId(documentData, mrzText);
    documentId = sanitizeFileComponent(documentId);
    if (!documentId || documentId.length < 2) documentId = `UNKNOWN_${Date.now()}`;

    const now = new Date();
    const baseFileName = `${documentId}_${formatFileTimestamp(now)}_${String(now.getMilliseconds()).padStart(3, '0')}`;

    const savedImages = renameAndSaveImages(images, baseFileName);
    saveResultFiles({ baseFileName, mrzText, documentData });

    console.log('[App] Step: notify renderer');
    sendToRenderer('scan-result', {
      ok: true,
      passportNo: documentId,
      documentId,
      documentType: docType?.name || 'UNKNOWN',
      mrz: mrzText,
      parsed: documentData,
      imagePath: savedImages[0] || null,
      images: savedImages,
      timestamp: new Date().toISOString()
    });

    // 같은 문서 중복 스캔 방지
    await sleep(1200);
  } catch (err) {
    console.error('[App] Scan error:', err.message, err.stack);
    // DLL/워커 호출이 멈춰버리면 다음 스캔이 영구적으로 안 되는 경우가 있어,
    // 타임아웃 계열 에러는 자동으로 워커를 재시작해 복구를 시도한다.
    if (String(err?.message || '').includes('timed out')) {
      consecutiveScanAutoTimeouts++;
      if (consecutiveScanAutoTimeouts >= 3) {
        // 계속 timeout이면 자동 스캔 루프를 잠시 멈추고(장치 상태 보호),
        // 사용자가 문서를 치우고 다시 올린 뒤 수동 스캔/재연결을 누를 수 있게 한다.
        console.warn('[App] Too many scan timeouts; stopping scan loop temporarily');
        stopScanLoop();
        sendToRenderer('scanner-status', { connected: !!scannerOpened, error: '스캔 타임아웃 반복 - 문서를 치우고 재시도/재연결 해주세요' });
        lastFailedAt = Date.now();
      } else {
        await forceReconnectScanner(err.message).catch(() => {});
      }
    }
  } finally {
    isScanning = false;
    if (pendingManualScan) {
      pendingManualScan = false;
      lastFailedAt = 0;
      // 현재 스캔이 끝난 직후, 큐잉된 수동 스캔을 1회 수행
      setTimeout(() => {
        performScan().catch(() => {});
      }, 50);
    }
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
  
  // 수동 스캔은 직전 실패 backoff를 무시하고 즉시 시도 (사용자가 "지금 스캔"을 눌렀는데 대기하면 UX가 나쁨)
  lastFailedAt = 0;
  console.log('[App] Manual scan requested');
  // 자동 스캔 루프가 이미 스캔 중이면 performScan()이 바로 return 하므로, 반드시 1회 큐잉한다.
  if (isScanning) {
    pendingManualScan = true;
    return { ok: true, queued: true };
  }
  performScan().catch(() => {});
  return { ok: true, queued: false };
});

ipcMain.handle('reconnect-scanner', async () => {
  const ok = await forceReconnectScanner('manual reconnect').catch(() => false);
  return { ok: !!ok };
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
