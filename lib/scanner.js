/**
 * QuantA64.dll 래퍼 모듈
 * koffi를 사용하여 네이티브 DLL 함수 호출
 */

const path = require('path');
const koffi = require('koffi');
const iconv = require('iconv-lite');

/**
 * CP949 버퍼를 UTF-8 문자열로 변환
 * @param {Buffer} buffer - null 종료 문자열 버퍼
 * @returns {string} UTF-8 문자열
 */
function decodeCP949(buffer) {
  if (!buffer || buffer.length === 0) {
    return '';
  }

  // null 종료 위치 찾기 (첫 번째 null 바이트)
  let nullIndex = -1;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      nullIndex = i;
      break;
    }
  }

  // 첫 바이트가 null이면 빈 문자열
  if (nullIndex === 0) {
    return '';
  }

  // 데이터 추출
  const data = nullIndex > 0 ? buffer.slice(0, nullIndex) : buffer;

  if (data.length === 0) {
    return '';
  }

  try {
    // CP949 (한글 Windows 기본 인코딩) → UTF-8
    const decoded = iconv.decode(data, 'cp949').trim();
    // null 문자 제거 (제어 문자는 유지 - 한글이 깨질 수 있음)
    return decoded.replace(/\x00/g, '');
  } catch (err) {
    console.error('[Scanner] decodeCP949 error:', err.message);
    return '';
  }
}

// DLL 경로 결정 (개발/프로덕션 환경 대응)
function getDllDirectory() {
  // Electron 패키징 여부 확인
  const isPackaged = typeof process !== 'undefined' &&
    process.mainModule &&
    process.mainModule.filename.indexOf('app.asar') !== -1;

  if (isPackaged) {
    // 패키징된 경우: 실행 파일 기준
    return path.dirname(process.execPath);
  } else {
    // 개발 환경: 프로젝트 루트
    return path.join(__dirname, '..');
  }
}

const dllDir = getDllDirectory();
const dllPath = path.join(dllDir, 'QuantA64.dll');

let lib = null;
let functions = {};

/**
 * DLL 로드 및 함수 바인딩
 */
function loadDll() {
  if (lib) return true;

  try {
    const { isMainThread } = require('worker_threads');

    // DLL 경로 출력 (디버깅용)
    console.log('[Scanner] DLL directory:', dllDir);
    console.log('[Scanner] DLL path:', dllPath);

    // DLL 디렉토리를 PATH에 추가 (의존 DLL 검색용)
    const currentPath = process.env.PATH || '';
    if (!currentPath.includes(dllDir)) {
      process.env.PATH = dllDir + path.delimiter + currentPath;
    }

    // 작업 디렉토리를 DLL 폴더로 변경 (의존 DLL 검색 강화)
    // - Node.js worker thread 환경에서는 process.chdir()가 지원되지 않을 수 있어 건너뜀
    const originalCwd = process.cwd();
    if (isMainThread) {
      try {
        process.chdir(dllDir);
      } catch (e) {
        console.warn('[Scanner] Could not change to DLL directory:', e.message);
      }
    }

    // DLL 파일 존재 확인
    const fs = require('fs');
    if (!fs.existsSync(dllPath)) {
      throw new Error(`DLL file not found: ${dllPath}`);
    }

    // 의존 DLL 확인
    const dependentDlls = ['QuantUsb64.dll', 'HsIdOCR64.dll', 'HsOCR64.dll', 'Crypt64.dll'];
    for (const dll of dependentDlls) {
      const depPath = path.join(dllDir, dll);
      if (!fs.existsSync(depPath)) {
        console.warn(`[Scanner] Dependent DLL missing: ${dll}`);
      }
    }

    lib = koffi.load(dllPath);

    // 작업 디렉토리 복원
    if (isMainThread) {
      try {
        process.chdir(originalCwd);
      } catch (e) {
        // 무시
      }
    }

    // 함수 정의
    const safeFunc = (signature) => {
      try {
        return lib.func(signature);
      } catch (e) {
        return null;
      }
    };

    functions = {
      // 장치 열기/닫기
      DeviceOpen: safeFunc('uint8_t QuantA6_DeviceOpen(void* hwnd)'),
      DeviceClose: safeFunc('bool QuantA6_DeviceClose()'),

      // 스캔
      Scan: safeFunc('uint8_t QuantA6_Scan(const char* pImageFileName, uint8_t nType)'),
      ScanCard: safeFunc('uint8_t QuantA6_Scan_Card(const char* pImageFileName, uint8_t nType)'),

      // 설정
      GetDpi: safeFunc('uint8_t QuantA6_GetDpi()'),
      SetDpi: safeFunc('bool QuantA6_SetDpi(uint8_t nDpi)'),
      GetBits: safeFunc('uint8_t QuantA6_GetBits()'),
      SetBits: safeFunc('bool QuantA6_SetBits(uint8_t nBits)'),
      GetThreshold: safeFunc('uint8_t QuantA6_GetThreshold()'),
      SetThreshold: safeFunc('bool QuantA6_SetThreshold(uint8_t nThreshold)'),

      // MRZ 읽기
      ReadMRZ: safeFunc('uint8_t QuantA6_ReadMRZ(int nDpi, char* strMrz)'),

      // OCR 함수들 (신분증)
      GetOCR_IDNo: safeFunc('int QuantA6_Get_OCR_IDNo(char* str)'),
      GetOCR_IDName: safeFunc('int QuantA6_Get_OCR_IDName(char* str)'),
      GetOCR_IDAddress: safeFunc('int QuantA6_Get_OCR_IDAddress(char* str)'),
      GetOCR_IDIssuedDate: safeFunc('int QuantA6_Get_OCR_IDIssuedDate(char* str)'),
      // 일부 SDK/펌웨어에서 주민등록번호가 이 함수로만 나오는 경우가 있음 (없으면 null)
      GetOCR_IDNumberAlt: safeFunc('int QuantA6s_Get_OCR_IDNumber(char* str)'),

      // 운전면허증 OCR
      GetOCR_DRIDNo: safeFunc('int QuantA6_Get_OCR_DRIDNo(char* str)'),
      GetOCR_DRName: safeFunc('int QuantA6_Get_OCR_DRName(char* str)'),
      GetOCR_DRLicenseNo: safeFunc('int QuantA6_Get_OCR_DRLicenseNo(char* str)'),
      GetOCR_DRIssuedDate: safeFunc('int QuantA6_Get_OCR_DRIssuedDate(char* str)'),
      GetOCR_DRAddress: safeFunc('int QuantA6_Get_OCR_DRAddress(char* str)'),
      GetOCR_DRType: safeFunc('int QuantA6_Get_OCR_DRType(char* str)'),
      GetOCR_DRPeriode: safeFunc('int QuantA6_Get_OCR_DRPeriode(char* str)'),

      // 외국인등록증 OCR
      GetOCR_AlienNumber: safeFunc('int QuantA6_Get_OCR_AlienNumber(char* str)'),
      GetOCR_AlienName: safeFunc('int QuantA6_Get_OCR_AlienName(char* str)'),
      GetOCR_AlienArea: safeFunc('int QuantA6_Get_OCR_AlienArea(char* str)'),
      GetOCR_AlienType: safeFunc('int QuantA6_Get_OCR_AlienType(char* str)'),

      // 기타
      DefaultSetting: safeFunc('void QuantA6_DefaultSetting()'),
      GetType: safeFunc('int QuantA6_GetType()'),

      // 센서 감지 (C# SDK 참조)
      GetSensorValueExt: safeFunc('uint8_t QuantA6_GetSensorValueExt(bool*, bool*, bool*, bool*)'),
    };

    console.log('[Scanner] DLL loaded successfully');
    return true;
  } catch (err) {
    console.error('[Scanner] Failed to load DLL:', err.message);
    return false;
  }
}

/**
 * 스캐너 클래스
 */
class Scanner {
  constructor() {
    this.isOpen = false;
    this.hwnd = null;
  }

  /**
   * DLL 초기화
   */
  init() {
    return loadDll();
  }

  /**
   * 장치 열기
   * @param {Buffer} hwnd - 윈도우 핸들 (Electron: win.getNativeWindowHandle())
   */
  open(hwnd) {
    if (!lib) {
      console.error('[Scanner] DLL not loaded');
      return false;
    }

    try {
      this.hwnd = hwnd || null;
      const result = functions.DeviceOpen(this.hwnd);

      // 0x00, 0xC7은 실패, 그 외는 성공
      if (result !== 0x00 && result !== 0xC7) {
        this.isOpen = true;
        // 기본 설정
        functions.SetDpi(3);   // 300 DPI
        functions.SetBits(32); // 32bit 컬러

        console.log('[Scanner] Device opened successfully');
        return true;
      } else {
        this.isOpen = false;
        console.log('[Scanner] Device open failed, code:', result);
        return false;
      }
    } catch (err) {
      console.error('[Scanner] Open error:', err.message);
      return false;
    }
  }

  /**
   * 장치 닫기
   */
  close() {
    if (!this.isOpen) return;

    try {
      functions.DeviceClose();
      this.isOpen = false;
      console.log('[Scanner] Device closed');
    } catch (err) {
      console.error('[Scanner] Close error:', err.message);
    }
  }

  /**
   * DLL 내부 상태 초기화
   * 스캔 실패/OCR 실패 후 다음 스캔에 영향을 주지 않도록 리셋
   */
  resetState() {
    if (!lib) return;

    try {
      functions.DefaultSetting();
      console.log('[Scanner] State reset (DefaultSetting called)');
    } catch (err) {
      console.error('[Scanner] ResetState error:', err.message);
    }
  }

  /**
   * 스캔 수행
   * @param {string} outputPath - 저장할 파일 경로 (확장자 제외)
   * @returns {boolean} 성공 여부
   */
  scan(outputPath) {
    if (!this.isOpen) {
      console.log('[Scanner] Device not open');
      return false;
    }

    try {
      console.log('[Scanner] Calling Scan with path:', outputPath);
      const result = functions.Scan(outputPath, 0x00);
      console.log('[Scanner] Scan returned:', result, '(0x' + result.toString(16) + ')');
      // 일반적으로 0x00 = 성공, 0xC7 = 문서 없음
      return result === 0x00;
    } catch (err) {
      console.error('[Scanner] Scan error:', err.message);
      return false;
    }
  }

  /**
   * 카드 스캔 (신분증용)
   * @param {string} outputPath - 저장할 파일 경로 (확장자 제외)
   * @returns {boolean} 성공 여부
   */
  scanCard(outputPath) {
    if (!this.isOpen) {
      console.log('[Scanner] Device not open');
      return false;
    }

    try {
      console.log('[Scanner] Calling ScanCard with path:', outputPath);
      const result = functions.ScanCard(outputPath, 0x00);
      console.log('[Scanner] ScanCard returned:', result, '(0x' + result.toString(16) + ')');
      return result === 0x00;
    } catch (err) {
      console.error('[Scanner] Scan card error:', err.message);
      return false;
    }
  }

  /**
   * 카드 스캔 (모드 지정)
   * @param {string} outputPath
   * @param {number} nType
   * @returns {number} DLL 반환 코드
   */
  scanCardWithType(outputPath, nType) {
    if (!this.isOpen) {
      return 0xf8;
    }
    if (!functions.ScanCard) {
      throw new Error('ScanCard function not available');
    }
    return functions.ScanCard(outputPath, nType);
  }

  /**
   * 센서 값 읽기 (C# SDK의 QuantA6_GetSensorValueExt 참조)
   * @returns {{ left: boolean, mid: boolean, right: boolean, cover: boolean } | null}
   */
  getSensorValue() {
    if (!lib || !functions.GetSensorValueExt) return null;

    try {
      // bool 포인터용 버퍼 할당
      const leftBuf = Buffer.alloc(1);
      const midBuf = Buffer.alloc(1);
      const rightBuf = Buffer.alloc(1);
      const coverBuf = Buffer.alloc(1);

      const result = functions.GetSensorValueExt(leftBuf, midBuf, rightBuf, coverBuf);
      if (result === 0) return null;

      return {
        left: leftBuf[0] !== 0,
        mid: midBuf[0] !== 0,
        right: rightBuf[0] !== 0,
        cover: coverBuf[0] !== 0
      };
    } catch (err) {
      console.error('[Scanner] GetSensorValue error:', err.message);
      return null;
    }
  }

  /**
   * 센서 값으로 문서 종류 감지 (C# SDK Form1.cs 참조)
   * left+mid+right = passport, left+mid only = card, else = none
   * @returns {{ hasDocument: boolean, type: 'passport' | 'card' | 'none', cover: boolean }}
   */
  detectDocumentType() {
    const sensors = this.getSensorValue();
    if (!sensors) {
      return { hasDocument: false, type: 'none', cover: false };
    }

    if (sensors.cover) {
      return { hasDocument: false, type: 'none', cover: true };
    }

    // C# SDK 로직:
    // bSensorLeft && bSensorMid && !bSensorRight → card
    // bSensorLeft && bSensorMid && bSensorRight → passport
    if (sensors.left && sensors.mid) {
      if (sensors.right) {
        return { hasDocument: true, type: 'passport', cover: false };
      } else {
        return { hasDocument: true, type: 'card', cover: false };
      }
    }

    return { hasDocument: false, type: 'none', cover: false };
  }

  /**
   * 여권 또는 카드 스캔 (센서 기반 자동 감지)
   * C# SDK 패턴: 센서로 문서 종류 판별 후 1회 스캔 호출
   * @param {string} outputPath - 저장할 파일 경로 (확장자 제외)
   * @returns {{ success: boolean, type: string }} 결과
   */
  scanAuto(outputPath) {
    if (!this.isOpen) {
      return { success: false, type: 'none' };
    }

    try {
      // 센서로 문서 종류 감지
      const detection = this.detectDocumentType();

      // 커버 열림 또는 문서 없음
      if (detection.cover || !detection.hasDocument) {
        return { success: false, type: 'none' };
      }

      // 스캔 전 초기화
      try {
        functions.DefaultSetting();
      } catch (_) { }

      let result;
      if (detection.type === 'card') {
        // 카드 스캔 (nType=0x00)
        result = functions.ScanCard(outputPath, 0x00);
        if (result === 0x00) {
          console.log('[Scanner] ScanCard success');
          return { success: true, type: 'card', cardType: 0x00 };
        }
      } else {
        // 여권 스캔
        result = functions.Scan(outputPath, 0x00);
        if (result === 0x00) {
          console.log('[Scanner] Scan success (passport)');
          return { success: true, type: 'passport' };
        }
      }

      // 스캔 실패
      return { success: false, type: 'none' };
    } catch (err) {
      console.error('[Scanner] ScanAuto error:', err.message);
      return { success: false, type: 'none' };
    }
  }

  /**
   * MRZ 읽기
   * @returns {string|null} MRZ 텍스트
   */
  readMRZ() {
    if (!lib) return null;

    try {
      // 버퍼 할당 (200자)
      const buffer = Buffer.alloc(200);
      functions.ReadMRZ(3, buffer);

      // null 종료 문자열 추출
      const nullIndex = buffer.indexOf(0);
      const mrzText = buffer.toString('utf8', 0, nullIndex > 0 ? nullIndex : buffer.length);
      return mrzText.trim();
    } catch (err) {
      console.error('[Scanner] ReadMRZ error:', err.message);
      return null;
    }
  }

  /**
   * OCR로 신분증 정보 읽기
   * @returns {object} 신분증 정보
   */
  readIDCard() {
    if (!lib) return null;

    try {
      const readField = (func, name) => {
        if (!func) return '';
        const buffer = Buffer.alloc(500);
        const ret = func(buffer);
        // 첫 20바이트 확인 (디버그)
        const first20 = buffer.slice(0, 20).toString('hex');
        console.log(`[Scanner] OCR ${name}: ret=${ret}, first20=${first20}`);
        return decodeCP949(buffer);
      };

      return {
        idNo: (() => {
          const v1 = readField(functions.GetOCR_IDNo, 'IDNo');
          if (v1) return v1;
          return readField(functions.GetOCR_IDNumberAlt, 'IDNumberAlt');
        })(),
        name: readField(functions.GetOCR_IDName, 'IDName'),
        address: readField(functions.GetOCR_IDAddress, 'IDAddress'),
        issuedDate: readField(functions.GetOCR_IDIssuedDate, 'IDIssuedDate'),
      };
    } catch (err) {
      console.error('[Scanner] ReadIDCard error:', err.message);
      return null;
    }
  }

  /**
   * 문서 종류 확인
   * @returns {object} { type: number, name: string }
   */
  getDocumentType() {
    if (!lib) return null;

    try {
      const type = functions.GetType();
      const typeNames = {
        1: 'ID_CARD',       // 주민등록증 (Type 1)
        2: 'DRIVER_LICENSE',// 운전면허증 (구형) - C#은 1,11이 주민, 2,3,5가 면허
        3: 'DRIVER_LICENSE',// 운전면허증 (구형)
        4: 'ALIEN_CARD',    // 외국인등록증
        5: 'DRIVER_LICENSE',// 운전면허증 (신형)
        11: 'ID_CARD',      // 신형 주민등록증 (Type 11)
        20: 'PASSPORT',     // 여권 (Type 20)
      };
      return {
        type,
        name: typeNames[type] || 'UNKNOWN'
      };
    } catch (err) {
      console.error('[Scanner] GetType error:', err.message);
      return null;
    }
  }

  /**
   * OCR로 운전면허증 정보 읽기
   * @returns {object} 운전면허증 정보
   */
  readDriverLicense() {
    if (!lib) return null;

    try {
      const readField = (func, name) => {
        if (!func) return '';
        const buffer = Buffer.alloc(500);
        const ret = func(buffer);
        // 첫 20바이트 확인 (디버그)
        const first20 = buffer.slice(0, 20).toString('hex');
        console.log(`[Scanner] OCR ${name}: ret=${ret}, first20=${first20}`);
        return decodeCP949(buffer);
      };

      return {
        idNo: readField(functions.GetOCR_DRIDNo, 'DRIDNo'),
        name: readField(functions.GetOCR_DRName, 'DRName'),
        licenseNo: readField(functions.GetOCR_DRLicenseNo, 'DRLicenseNo'),
        issuedDate: readField(functions.GetOCR_DRIssuedDate, 'DRIssuedDate'),
        address: readField(functions.GetOCR_DRAddress, 'DRAddress'),
        licenseType: readField(functions.GetOCR_DRType, 'DRType'),
        validPeriod: readField(functions.GetOCR_DRPeriode, 'DRPeriode'),
      };
    } catch (err) {
      console.error('[Scanner] ReadDriverLicense error:', err.message);
      return null;
    }
  }

  /**
   * OCR로 외국인등록증 정보 읽기
   * @returns {object} 외국인등록증 정보
   */
  readAlienCard() {
    if (!lib) return null;

    try {
      const readField = (func, name) => {
        if (!func) return '';
        const buffer = Buffer.alloc(500);
        const ret = func(buffer);
        const first20 = buffer.slice(0, 20).toString('hex');
        console.log(`[Scanner] OCR ${name}: ret=${ret}, first20=${first20}`);
        return decodeCP949(buffer);
      };

      return {
        alienNo: readField(functions.GetOCR_AlienNumber, 'AlienNumber'),
        name: readField(functions.GetOCR_AlienName, 'AlienName'),
        area: readField(functions.GetOCR_AlienArea, 'AlienArea'),
        visaType: readField(functions.GetOCR_AlienType, 'AlienType'),
      };
    } catch (err) {
      console.error('[Scanner] ReadAlienCard error:', err.message);
      return null;
    }
  }

  /**
   * 장치 열림 상태 확인
   */
  get opened() {
    return this.isOpen;
  }
}

module.exports = Scanner;
