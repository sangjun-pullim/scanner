# 신분증 스캐너 통합 가이드

> Vite + Electron 환전소 POS 앱에 여권/신분증 스캔 기능을 통합하는 방법

## 📋 개요

환전 마무리 단계에서 고객 신분증을 스캔하여 이미지와 정보(MRZ/OCR)를 저장하는 기능을 구현합니다.

### 지원 문서
- 여권 (Passport) - MRZ 인식
- 주민등록증 (ID Card) - OCR 인식
- 운전면허증 (Driver License) - OCR 인식
- 외국인등록증 (Alien Card) - OCR 인식

---

## 📁 프로젝트 구조

POS 앱에 다음 파일/폴더를 추가합니다:

```
your-pos-app/
├── electron/
│   ├── main.ts (or main.js)      # 기존 Electron 메인 프로세스
│   ├── preload.ts                # 기존 preload 스크립트
│   └── scanner/                  # 🆕 스캐너 모듈 폴더
│       ├── scanner.ts            # DLL 래퍼
│       ├── mrz-parser.ts         # MRZ 파서
│       ├── usb-monitor.ts        # USB 모니터 (선택)
│       ├── scanner-service.ts    # 스캔 서비스 (IPC 통합)
│       └── types.ts              # 타입 정의
├── dlls/                         # 🆕 스캐너 DLL 파일들
│   ├── QuantA64.dll
│   ├── QuantUsb64.dll
│   ├── HsIdOCR64.dll
│   ├── HsOCR64.dll
│   ├── HsidRec64.dll
│   ├── Crypt64.dll
│   └── ... (기타 DLL)
└── package.json
```

---

## 📦 1단계: 의존성 설치

```bash
# 필수 의존성
npm install koffi iconv-lite

# 선택 (USB 핫플러그 감지 - Windows에서 빌드 이슈 있을 수 있음)
npm install usb-detection
```

### package.json 수정

```json
{
  "dependencies": {
    "koffi": "^2.8.0",
    "iconv-lite": "^0.7.1"
  }
}
```

---

## 📦 2단계: DLL 파일 복사

### 개발 환경
DLL 파일들을 프로젝트 루트 또는 `dlls/` 폴더에 복사합니다.

### 빌드 설정 (electron-builder)

`package.json` 또는 `electron-builder.yml`에 extraFiles 설정 추가:

```json
{
  "build": {
    "extraFiles": [
      {
        "from": "dlls/",
        "to": ".",
        "filter": ["*.dll"]
      }
    ]
  }
}
```

### Vite 설정 (vite.config.ts)

```typescript
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['koffi', 'iconv-lite'] // 네이티브 모듈 외부화
    }
  }
})
```

---

## 📝 3단계: 스캐너 모듈 코드

### 3-1. 타입 정의 (`electron/scanner/types.ts`)

```typescript
export interface ScanResult {
  ok: boolean;
  documentId: string;
  documentType: 'PASSPORT' | 'ID_CARD' | 'DRIVER_LICENSE' | 'ALIEN_CARD' | 'UNKNOWN';
  mrz?: string;
  parsed?: ParsedDocument;
  imagePath: string | null;
  images: string[];
  timestamp: string;
  error?: string;
}

export interface ParsedDocument {
  documentType?: string;
  // 여권 (Passport)
  passportNo?: string;
  surname?: string;
  givenNames?: string;
  fullName?: string;
  nationality?: string;
  birthDate?: string;
  sex?: string;
  expiryDate?: string;
  issuingCountry?: string;
  // 주민등록증 (OCR)
  name?: string;
  idNo?: string;           // 주민번호
  address?: string;
  issuedDate?: string;
  // 운전면허증 (OCR)
  licenseNo?: string;      // 면허번호
  licenseType?: string;    // 면허 종류 (1종보통 등)
  validPeriod?: string;    // 적성검사 기간
  // 외국인등록증 (OCR)
  alienNo?: string;        // 외국인등록번호
  area?: string;           // 지역
  visaType?: string;       // 체류자격 (F-4, E-9 등)
}

export interface ScannerStatus {
  connected: boolean;
  error?: string;
}
```

### 3-2. DLL 래퍼 (`electron/scanner/scanner.ts`)

```typescript
/**
 * QuantA64.dll 래퍼 모듈
 */

import path from 'path';
import fs from 'fs';
import koffi from 'koffi';
import iconv from 'iconv-lite';

function decodeCP949(buffer: Buffer): string {
  if (!buffer || buffer.length === 0) return '';
  
  let nullIndex = buffer.indexOf(0);
  if (nullIndex === 0) return '';
  
  const data = nullIndex > 0 ? buffer.slice(0, nullIndex) : buffer;
  if (data.length === 0) return '';
  
  try {
    return iconv.decode(data, 'cp949').trim().replace(/\x00/g, '');
  } catch {
    return '';
  }
}

function getDllDirectory(): string {
  // Electron 패키징 여부
  const isPackaged = process.mainModule?.filename.includes('app.asar') ?? false;
  
  if (isPackaged) {
    return path.dirname(process.execPath);
  }
  // 개발 환경: 프로젝트 루트의 dlls 폴더 또는 루트
  return path.join(__dirname, '..', '..', 'dlls');
}

let lib: any = null;
let functions: Record<string, any> = {};

function loadDll(): boolean {
  if (lib) return true;
  
  const dllDir = getDllDirectory();
  const dllPath = path.join(dllDir, 'QuantA64.dll');
  
  try {
    console.log('[Scanner] DLL path:', dllPath);
    
    if (!fs.existsSync(dllPath)) {
      throw new Error(`DLL not found: ${dllPath}`);
    }
    
    // PATH에 DLL 디렉토리 추가
    const currentPath = process.env.PATH || '';
    if (!currentPath.includes(dllDir)) {
      process.env.PATH = dllDir + path.delimiter + currentPath;
    }
    
    lib = koffi.load(dllPath);
    
    const safeFunc = (sig: string) => {
      try { return lib.func(sig); } catch { return null; }
    };
    
    functions = {
      DeviceOpen: safeFunc('uint8_t QuantA6_DeviceOpen(void* hwnd)'),
      DeviceClose: safeFunc('bool QuantA6_DeviceClose()'),
      Scan: safeFunc('uint8_t QuantA6_Scan(const char* pImageFileName, uint8_t nType)'),
      ScanCard: safeFunc('uint8_t QuantA6_Scan_Card(const char* pImageFileName, uint8_t nType)'),
      SetDpi: safeFunc('bool QuantA6_SetDpi(uint8_t nDpi)'),
      SetBits: safeFunc('bool QuantA6_SetBits(uint8_t nBits)'),
      ReadMRZ: safeFunc('uint8_t QuantA6_ReadMRZ(int nDpi, char* strMrz)'),
      GetOCR_IDNo: safeFunc('int QuantA6_Get_OCR_IDNo(char* str)'),
      GetOCR_IDName: safeFunc('int QuantA6_Get_OCR_IDName(char* str)'),
      GetOCR_IDAddress: safeFunc('int QuantA6_Get_OCR_IDAddress(char* str)'),
      GetOCR_IDIssuedDate: safeFunc('int QuantA6_Get_OCR_IDIssuedDate(char* str)'),
      GetOCR_DRIDNo: safeFunc('int QuantA6_Get_OCR_DRIDNo(char* str)'),
      GetOCR_DRName: safeFunc('int QuantA6_Get_OCR_DRName(char* str)'),
      GetOCR_DRLicenseNo: safeFunc('int QuantA6_Get_OCR_DRLicenseNo(char* str)'),
      GetOCR_DRIssuedDate: safeFunc('int QuantA6_Get_OCR_DRIssuedDate(char* str)'),
      GetOCR_DRAddress: safeFunc('int QuantA6_Get_OCR_DRAddress(char* str)'),
      GetOCR_DRType: safeFunc('int QuantA6_Get_OCR_DRType(char* str)'),
      GetOCR_DRPeriode: safeFunc('int QuantA6_Get_OCR_DRPeriode(char* str)'),
      GetOCR_AlienNumber: safeFunc('int QuantA6_Get_OCR_AlienNumber(char* str)'),
      GetOCR_AlienName: safeFunc('int QuantA6_Get_OCR_AlienName(char* str)'),
      GetOCR_AlienArea: safeFunc('int QuantA6_Get_OCR_AlienArea(char* str)'),
      GetOCR_AlienType: safeFunc('int QuantA6_Get_OCR_AlienType(char* str)'),
      DefaultSetting: safeFunc('void QuantA6_DefaultSetting()'),
      GetType: safeFunc('int QuantA6_GetType()'),
    };
    
    console.log('[Scanner] DLL loaded');
    return true;
  } catch (err: any) {
    console.error('[Scanner] DLL load failed:', err.message);
    return false;
  }
}

export class Scanner {
  private isOpen = false;
  private hwnd: Buffer | null = null;
  
  init(): boolean {
    return loadDll();
  }
  
  open(hwnd?: Buffer): boolean {
    if (!lib) return false;
    
    try {
      this.hwnd = hwnd || null;
      const result = functions.DeviceOpen(this.hwnd);
      
      if (result !== 0x00 && result !== 0xC7) {
        this.isOpen = true;
        functions.SetDpi(3);   // 300 DPI
        functions.SetBits(32); // 32bit 컬러
        console.log('[Scanner] Device opened');
        return true;
      }
      return false;
    } catch (err: any) {
      console.error('[Scanner] Open error:', err.message);
      return false;
    }
  }
  
  close(): void {
    if (!this.isOpen) return;
    try {
      functions.DeviceClose();
      this.isOpen = false;
    } catch {}
  }
  
  get opened(): boolean {
    return this.isOpen;
  }
  
  scanAuto(outputPath: string): { success: boolean; type: string; cardType?: number } {
    if (!this.isOpen) return { success: false, type: 'none' };
    
    try {
      functions.DefaultSetting?.();
      
      // 1. 여권 스캔 시도
      let result = functions.Scan(outputPath, 0x00);
      if (result === 0x00) {
        return { success: true, type: 'passport' };
      }
      
      // 2. 신분증 스캔 시도
      if (result === 0xf8 || result === 0xc7) {
        functions.DefaultSetting?.();
        const cardTypes = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07];
        
        for (const cardType of cardTypes) {
          result = functions.ScanCard(outputPath, cardType);
          if (result === 0x00) {
            return { success: true, type: 'card', cardType };
          }
        }
      }
      
      return { success: false, type: 'none' };
    } catch {
      return { success: false, type: 'none' };
    }
  }
  
  readMRZ(): string | null {
    if (!lib) return null;
    try {
      const buffer = Buffer.alloc(200);
      functions.ReadMRZ(3, buffer);
      const nullIndex = buffer.indexOf(0);
      return buffer.toString('utf8', 0, nullIndex > 0 ? nullIndex : buffer.length).trim();
    } catch {
      return null;
    }
  }
  
  readIDCard() {
    if (!lib) return null;
    const readField = (func: any) => {
      if (!func) return '';
      const buffer = Buffer.alloc(500);
      func(buffer);
      return decodeCP949(buffer);
    };
    
    return {
      idNo: readField(functions.GetOCR_IDNo),
      name: readField(functions.GetOCR_IDName),
      address: readField(functions.GetOCR_IDAddress),
      issuedDate: readField(functions.GetOCR_IDIssuedDate),
    };
  }
  
  readDriverLicense() {
    if (!lib) return null;
    const readField = (func: any) => {
      if (!func) return '';
      const buffer = Buffer.alloc(500);
      func(buffer);
      return decodeCP949(buffer);
    };
    
    return {
      idNo: readField(functions.GetOCR_DRIDNo),
      name: readField(functions.GetOCR_DRName),
      licenseNo: readField(functions.GetOCR_DRLicenseNo),
      issuedDate: readField(functions.GetOCR_DRIssuedDate),
      address: readField(functions.GetOCR_DRAddress),
      licenseType: readField(functions.GetOCR_DRType),
      validPeriod: readField(functions.GetOCR_DRPeriode),
    };
  }
  
  readAlienCard() {
    if (!lib) return null;
    const readField = (func: any) => {
      if (!func) return '';
      const buffer = Buffer.alloc(500);
      func(buffer);
      return decodeCP949(buffer);
    };
    
    return {
      alienNo: readField(functions.GetOCR_AlienNumber),
      name: readField(functions.GetOCR_AlienName),
      area: readField(functions.GetOCR_AlienArea),
      visaType: readField(functions.GetOCR_AlienType),
    };
  }
  
  getDocumentType() {
    if (!lib) return null;
    const type = functions.GetType?.() ?? 0;
    const names: Record<number, string> = {
      0: 'UNKNOWN', 1: 'PASSPORT', 2: 'ID_CARD', 3: 'DRIVER_LICENSE', 4: 'ALIEN_CARD'
    };
    return { type, name: names[type] || 'UNKNOWN' };
  }
}
```

### 3-3. MRZ 파서 (`electron/scanner/mrz-parser.ts`)

```typescript
/**
 * MRZ (Machine Readable Zone) 파서 - ICAO 9303
 */

function normalizeMrz(mrzRaw: string): { line1: string; line2: string } | null {
  if (!mrzRaw) return null;
  
  let cleaned = mrzRaw.replace(/[\u0000-\u001F\r]/g, '').trim();
  cleaned = cleaned.replace(/ /g, '<').replace(/[^A-Z0-9<\n]/g, '');
  
  const parts = cleaned.split('\n').filter(s => s.length > 0);
  
  if (parts.length >= 2) {
    return {
      line1: parts[0].padEnd(44, '<').substring(0, 44),
      line2: parts[1].padEnd(44, '<').substring(0, 44)
    };
  }
  
  cleaned = cleaned.replace(/\n/g, '');
  if (cleaned.length >= 88) {
    return {
      line1: cleaned.substring(0, 44),
      line2: cleaned.substring(44, 88)
    };
  }
  
  return null;
}

export function extractPassportNo(mrzRaw: string): string | null {
  const normalized = normalizeMrz(mrzRaw);
  if (!normalized) return null;
  return normalized.line2.substring(0, 9).replace(/</g, '').toUpperCase() || null;
}

function formatMrzDate(dateStr: string): string {
  if (!dateStr || dateStr.length !== 6) return '';
  let year = parseInt(dateStr.substring(0, 2), 10);
  year = year > 50 ? 1900 + year : 2000 + year;
  return `${year}-${dateStr.substring(2, 4)}-${dateStr.substring(4, 6)}`;
}

export function parseMrzFull(mrzRaw: string) {
  const normalized = normalizeMrz(mrzRaw);
  if (!normalized) return null;
  
  const { line1, line2 } = normalized;
  
  try {
    const documentType = line1.substring(0, 2).replace(/</g, '');
    const issuingCountry = line1.substring(2, 5).replace(/</g, '');
    const namePart = line1.substring(5, 44);
    const nameSplit = namePart.split('<<');
    const surname = (nameSplit[0] || '').replace(/</g, ' ').trim();
    const givenNames = (nameSplit[1] || '').replace(/</g, ' ').trim();
    
    const passportNo = line2.substring(0, 9).replace(/</g, '');
    const nationality = line2.substring(10, 13).replace(/</g, '');
    const birthDate = line2.substring(13, 19);
    const sex = line2[20];
    const expiryDate = line2.substring(21, 27);
    
    return {
      documentType,
      issuingCountry,
      surname,
      givenNames,
      fullName: `${surname} ${givenNames}`.trim(),
      passportNo,
      nationality,
      birthDate: formatMrzDate(birthDate),
      sex: sex === 'M' ? 'Male' : sex === 'F' ? 'Female' : 'Unknown',
      expiryDate: formatMrzDate(expiryDate),
    };
  } catch {
    return null;
  }
}
```

### 3-4. 스캔 서비스 (`electron/scanner/scanner-service.ts`)

```typescript
/**
 * 스캐너 서비스 - IPC 통합 및 비즈니스 로직
 */

import { BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { Scanner } from './scanner';
import { extractPassportNo, parseMrzFull } from './mrz-parser';
import type { ScanResult, ScannerStatus, ParsedDocument } from './types';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class ScannerService {
  private scanner: Scanner;
  private mainWindow: BrowserWindow | null = null;
  private saveFolder: string;
  private isScanning = false;
  
  constructor(saveFolder: string = 'C:\\passport-scan') {
    this.scanner = new Scanner();
    this.saveFolder = saveFolder;
  }
  
  /**
   * 서비스 초기화 (앱 시작 시 호출)
   */
  init(mainWindow: BrowserWindow): boolean {
    this.mainWindow = mainWindow;
    
    // 저장 폴더 생성
    if (!fs.existsSync(this.saveFolder)) {
      fs.mkdirSync(this.saveFolder, { recursive: true });
    }
    
    // DLL 로드
    if (!this.scanner.init()) {
      this.sendStatus({ connected: false, error: 'DLL 로드 실패' });
      return false;
    }
    
    // IPC 핸들러 등록
    this.registerIpcHandlers();
    
    // 스캐너 연결 시도
    this.tryConnect();
    
    return true;
  }
  
  /**
   * 스캐너 연결 시도
   */
  tryConnect(): boolean {
    let hwnd: Buffer | undefined;
    try {
      hwnd = this.mainWindow?.getNativeWindowHandle();
    } catch {}
    
    const connected = this.scanner.open(hwnd);
    this.sendStatus({ connected });
    return connected;
  }
  
  /**
   * 스캐너 연결 해제
   */
  disconnect(): void {
    this.scanner.close();
    this.sendStatus({ connected: false });
  }
  
  /**
   * IPC 핸들러 등록
   */
  private registerIpcHandlers(): void {
    // 스캐너 상태 조회
    ipcMain.handle('scanner:getStatus', () => ({
      connected: this.scanner.opened,
      saveFolder: this.saveFolder
    }));
    
    // 스캔 실행 (환전 완료 시 호출)
    ipcMain.handle('scanner:scan', async () => {
      return this.performScan();
    });
    
    // 스캐너 재연결
    ipcMain.handle('scanner:reconnect', () => {
      this.disconnect();
      return { ok: this.tryConnect() };
    });
  }
  
  /**
   * 스캔 수행 (메인 로직)
   */
  async performScan(): Promise<ScanResult> {
    if (this.isScanning) {
      return { ok: false, documentId: '', documentType: 'UNKNOWN', imagePath: null, images: [], timestamp: new Date().toISOString(), error: '이미 스캔 중입니다' };
    }
    
    if (!this.scanner.opened) {
      return { ok: false, documentId: '', documentType: 'UNKNOWN', imagePath: null, images: [], timestamp: new Date().toISOString(), error: '스캐너가 연결되지 않았습니다' };
    }
    
    this.isScanning = true;
    
    try {
      const now = new Date();
      const timestamp = this.formatTimestamp(now);
      const tempBase = path.join(this.saveFolder, timestamp);
      
      // 스캔 실행
      const scanResult = this.scanner.scanAuto(tempBase);
      
      if (!scanResult.success) {
        this.isScanning = false;
        return { ok: false, documentId: '', documentType: 'UNKNOWN', imagePath: null, images: [], timestamp: now.toISOString(), error: '문서가 감지되지 않았습니다' };
      }
      
      // 파일 생성 대기
      const expectedBmpPath = path.join(this.saveFolder, `${timestamp}.bmp`);
      await this.waitForFile(expectedBmpPath, 8000);
      await sleep(600);
      
      // 문서 정보 추출
      let documentId = `UNKNOWN_${Date.now()}`;
      let documentData: ParsedDocument | null = null;
      let mrzText = '';
      
      // MRZ 읽기 시도 (여권)
      for (let i = 0; i < 5; i++) {
        const mrz = this.scanner.readMRZ() || '';
        if (this.isValidPassportMRZ(mrz)) {
          mrzText = mrz;
          documentId = extractPassportNo(mrz) || documentId;
          documentData = parseMrzFull(mrz);
          if (documentData) documentData.documentType = 'PASSPORT';
          break;
        }
        await sleep(200);
      }
      
      // OCR 읽기 시도 (신분증)
      if (!documentData && scanResult.type === 'card') {
        for (let i = 0; i < 5; i++) {
          const idCard = this.scanner.readIDCard();
          const license = this.scanner.readDriverLicense();
          const alien = this.scanner.readAlienCard();
          
          if (this.isValidKoreanRRN(idCard?.idNo)) {
            documentId = String(idCard!.idNo).replace(/-/g, '').substring(0, 6);
            documentData = { ...idCard!, documentType: 'ID_CARD' };
            break;
          }
          if (this.isValidDriverLicense(license?.licenseNo)) {
            documentId = license!.licenseNo!.replace(/-/g, '');
            documentData = { ...license!, documentType: 'DRIVER_LICENSE' };
            break;
          }
          if (this.isValidAlienRegNo(alien?.alienNo)) {
            documentId = alien!.alienNo!.replace(/-/g, '').substring(0, 6);
            documentData = { ...alien!, documentType: 'ALIEN_CARD' };
            break;
          }
          await sleep(200);
        }
      }
      
      // 파일 이름 변경
      const docType = this.scanner.getDocumentType();
      documentId = documentId.replace(/[\x00-\x1F\x7F<>:"/\\|?*]/g, '').trim() || `UNKNOWN_${Date.now()}`;
      
      const savedImages = this.renameScannedFiles(timestamp, documentId);
      
      // 텍스트/JSON 저장
      this.saveDocumentData(documentId, mrzText, documentData);
      
      const result: ScanResult = {
        ok: true,
        documentId,
        documentType: (docType?.name || documentData?.documentType || 'UNKNOWN') as ScanResult['documentType'],
        mrz: mrzText,
        parsed: documentData || undefined,
        imagePath: savedImages[0] || null,
        images: savedImages,
        timestamp: now.toISOString()
      };
      
      // Renderer에 결과 전송
      this.sendToRenderer('scanner:result', result);
      
      this.isScanning = false;
      return result;
      
    } catch (err: any) {
      this.isScanning = false;
      return { ok: false, documentId: '', documentType: 'UNKNOWN', imagePath: null, images: [], timestamp: new Date().toISOString(), error: err.message };
    }
  }
  
  // === 유틸리티 함수들 ===
  
  private formatTimestamp(date: Date): string {
    return date.getFullYear().toString() +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0') + '_' +
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0') +
      String(date.getSeconds()).padStart(2, '0');
  }
  
  private async waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(filePath)) return true;
      await sleep(250);
    }
    return fs.existsSync(filePath);
  }
  
  private isValidPassportMRZ(mrz: string | null): boolean {
    if (!mrz) return false;
    const cleaned = mrz.replace(/\s/g, '');
    return (cleaned.startsWith('P') || cleaned.startsWith('P<')) && cleaned.length >= 60;
  }
  
  private isValidKoreanRRN(idNo: string | undefined): boolean {
    if (!idNo) return false;
    return /^\d{6}-\d{7}$/.test(idNo) || /^\d{13}$/.test(idNo);
  }
  
  private isValidDriverLicense(licenseNo: string | undefined): boolean {
    if (!licenseNo) return false;
    return /^\d{2}-\d{2}-\d{6}-\d{2}$/.test(licenseNo);
  }
  
  private isValidAlienRegNo(alienNo: string | undefined): boolean {
    if (!alienNo) return false;
    const s = alienNo.trim();
    // 외국인등록번호: YYMMDD-XXXXXXX (뒷자리 첫 숫자 5,6,7,8)
    if (/^\d{6}-[5-8]\d{6}$/.test(s)) return true;
    if (/^\d{13}$/.test(s) && ['5', '6', '7', '8'].includes(s[6])) return true;
    return false;
  }
  
  private renameScannedFiles(timestamp: string, documentId: string): string[] {
    const savedImages: string[] = [];
    const files = [`${timestamp}.bmp`, `${timestamp}_IR.bmp`];
    
    const ms = String(new Date().getMilliseconds()).padStart(3, '0');
    const baseFileName = `${documentId}_${timestamp}_${ms}`;
    
    files.forEach((file, idx) => {
      const srcPath = path.join(this.saveFolder, file);
      if (fs.existsSync(srcPath)) {
        const suffix = file.includes('_IR') ? '_IR' : '';
        const destPath = path.join(this.saveFolder, `${baseFileName}${suffix}.bmp`);
        fs.renameSync(srcPath, destPath);
        savedImages.push(destPath);
      }
    });
    
    return savedImages;
  }
  
  private saveDocumentData(documentId: string, mrzText: string, data: ParsedDocument | null): void {
    const basePath = path.join(this.saveFolder, documentId);
    
    // 텍스트 파일
    let textContent = '';
    if (mrzText) {
      textContent = mrzText;
    } else if (data?.documentType) {
      const lines = [`[${data.documentType}]`];
      if (data.name) lines.push(`이름: ${data.name}`);
      if (data.idNo) lines.push(`주민번호: ${data.idNo}`);
      if (data.licenseNo) lines.push(`면허번호: ${data.licenseNo}`);
      if (data.licenseType) lines.push(`면허종류: ${data.licenseType}`);
      if (data.validPeriod) lines.push(`적성기간: ${data.validPeriod}`);
      if (data.alienNo) lines.push(`외국인번호: ${data.alienNo}`);
      if (data.visaType) lines.push(`체류자격: ${data.visaType}`);
      if (data.area) lines.push(`지역: ${data.area}`);
      if (data.address) lines.push(`주소: ${data.address}`);
      if (data.issuedDate) lines.push(`발급일: ${data.issuedDate}`);
      textContent = lines.join('\n');
    }
    
    if (textContent) {
      fs.writeFileSync(`${basePath}.txt`, '\ufeff' + textContent, 'utf8');
    }
    
    // JSON 파일
    if (data) {
      fs.writeFileSync(`${basePath}.json`, JSON.stringify(data, null, 2), 'utf8');
    }
  }
  
  private sendStatus(status: ScannerStatus): void {
    this.sendToRenderer('scanner:status', status);
  }
  
  private sendToRenderer(channel: string, data: any): void {
    this.mainWindow?.webContents.send(channel, data);
  }
}
```

---

## 🔌 4단계: Electron 메인 프로세스 통합

### `electron/main.ts` 수정

```typescript
import { app, BrowserWindow } from 'electron';
import { ScannerService } from './scanner/scanner-service';

let mainWindow: BrowserWindow | null = null;
let scannerService: ScannerService | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  
  // ... 기존 윈도우 로드 코드 ...
}

app.whenReady().then(() => {
  createWindow();
  
  // 🆕 스캐너 서비스 초기화
  if (mainWindow) {
    scannerService = new ScannerService('C:\\exchange-pos\\scans');
    scannerService.init(mainWindow);
  }
});

app.on('window-all-closed', () => {
  // 🆕 스캐너 정리
  scannerService?.disconnect();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

---

## 🔐 5단계: Preload 스크립트 수정

### `electron/preload.ts`

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('scannerAPI', {
  // 스캐너 상태 조회
  getStatus: () => ipcRenderer.invoke('scanner:getStatus'),
  
  // 스캔 실행 (한 번만 스캔)
  scan: () => ipcRenderer.invoke('scanner:scan'),
  
  // 스캐너 재연결
  reconnect: () => ipcRenderer.invoke('scanner:reconnect'),
  
  // 🆕 스캔 루프 제어 (페이지 진입/이탈 시 사용)
  startScanLoop: () => ipcRenderer.invoke('scanner:startScanLoop'),
  stopScanLoop: () => ipcRenderer.invoke('scanner:stopScanLoop'),
  getScanLoopStatus: () => ipcRenderer.invoke('scanner:getScanLoopStatus'),
  
  // 스캔 결과 이벤트 리스너
  onScanResult: (callback: (result: any) => void) => {
    ipcRenderer.on('scanner:result', (_event, data) => callback(data));
  },
  
  // 스캐너 상태 변경 이벤트 리스너
  onStatusChange: (callback: (status: any) => void) => {
    ipcRenderer.on('scanner:status', (_event, data) => callback(data));
  },
  
  // 리스너 해제
  removeListeners: () => {
    ipcRenderer.removeAllListeners('scanner:result');
    ipcRenderer.removeAllListeners('scanner:status');
  }
});

// 🆕 타입 선언 (TypeScript용)
declare global {
  interface Window {
    scannerAPI: {
      getStatus: () => Promise<{ connected: boolean; saveFolder: string }>;
      scan: () => Promise<ScanResult>;
      reconnect: () => Promise<{ ok: boolean }>;
      onScanResult: (callback: (result: ScanResult) => void) => void;
      onStatusChange: (callback: (status: { connected: boolean }) => void) => void;
      removeListeners: () => void;
    };
  }
}
```

---

## 🎨 6단계: Renderer (Vue/React) 사용 예시

### 방식 1: 버튼 클릭 시 스캔

```typescript
// Vue 3 예시 - 버튼 클릭 시 한 번 스캔
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const scannerConnected = ref(false);
const scanResult = ref<ScanResult | null>(null);
const isScanning = ref(false);

onMounted(() => {
  window.scannerAPI.getStatus().then(status => {
    scannerConnected.value = status.connected;
  });
});

onUnmounted(() => {
  window.scannerAPI.removeListeners();
});

async function scanOnce() {
  isScanning.value = true;
  const result = await window.scannerAPI.scan();
  scanResult.value = result;
  isScanning.value = false;
  return result;
}
</script>
```

### 방식 2: 페이지 진입 시 자동 감지 루프 ⭐ (권장)

신분증 확인 페이지에 진입하면 자동으로 스캔 대기, 문서가 감지되면 자동 스캔

```typescript
// Vue 3 예시 - 신분증 확인 페이지
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const scannerConnected = ref(false);
const scanResult = ref<ScanResult | null>(null);
const isWaiting = ref(true);  // 문서 대기 중

onMounted(async () => {
  // 스캐너 상태 확인
  const status = await window.scannerAPI.getStatus();
  scannerConnected.value = status.connected;
  
  if (!status.connected) {
    alert('스캐너가 연결되지 않았습니다');
    return;
  }
  
  // 🔄 스캔 결과 리스너 등록
  window.scannerAPI.onScanResult((result) => {
    if (result.ok) {
      scanResult.value = result;
      isWaiting.value = false;
      
      // ✅ 스캔 성공 - 루프 중지
      window.scannerAPI.stopScanLoop();
      
      // 다음 단계로 진행 (예: 환전 정보 저장)
      saveIdentityToExchange(result);
    }
  });
  
  // 🚀 페이지 진입 시 스캔 루프 시작
  await window.scannerAPI.startScanLoop();
  console.log('스캔 대기 중... 신분증을 스캐너에 올려주세요');
});

onUnmounted(() => {
  // 🛑 페이지 이탈 시 스캔 루프 중지
  window.scannerAPI.stopScanLoop();
  window.scannerAPI.removeListeners();
});

function saveIdentityToExchange(result: ScanResult) {
  const identityData = {
    documentType: result.documentType,
    documentId: result.documentId,
    imagePath: result.imagePath,
    name: result.parsed?.fullName || result.parsed?.name,
    nationality: result.parsed?.nationality,
    scannedAt: result.timestamp
  };
  
  // API 호출하여 환전 거래에 신분증 정보 연결
  // ...
}

// 재스캔 버튼
async function rescan() {
  scanResult.value = null;
  isWaiting.value = true;
  await window.scannerAPI.startScanLoop();
}
</script>

<template>
  <div class="identity-check-page">
    <!-- 스캐너 상태 -->
    <div :class="['status', { connected: scannerConnected }]">
      {{ scannerConnected ? '🟢 스캐너 연결됨' : '🔴 스캐너 미연결' }}
    </div>
    
    <!-- 대기 화면 -->
    <div v-if="isWaiting && !scanResult" class="waiting">
      <div class="spinner"></div>
      <p>신분증을 스캐너에 올려주세요...</p>
    </div>
    
    <!-- 스캔 결과 -->
    <div v-if="scanResult?.ok" class="result">
      <img :src="`file://${scanResult.imagePath}`" alt="스캔 이미지" />
      <div class="info">
        <p>📄 문서 종류: {{ scanResult.documentType }}</p>
        <p>👤 이름: {{ scanResult.parsed?.fullName || scanResult.parsed?.name }}</p>
        <p>🆔 문서번호: {{ scanResult.documentId }}</p>
      </div>
      <button @click="rescan">다시 스캔</button>
      <button @click="confirmAndProceed">확인 후 환전 진행</button>
    </div>
  </div>
</template>
```

### 방식 1 상세 (기존 코드)

```typescript
// Vue 3 예시
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const scannerConnected = ref(false);
const scanResult = ref<ScanResult | null>(null);
const isScanning = ref(false);

onMounted(() => {
  // 스캐너 상태 확인
  window.scannerAPI.getStatus().then(status => {
    scannerConnected.value = status.connected;
  });
  
  // 스캔 결과 리스너
  window.scannerAPI.onScanResult((result) => {
    scanResult.value = result;
    isScanning.value = false;
    
    if (result.ok) {
      // 🎉 스캔 성공 - 환전 데이터에 신분증 정보 저장
      saveIdentityToExchange(result);
    }
  });
  
  // 스캐너 상태 리스너
  window.scannerAPI.onStatusChange((status) => {
    scannerConnected.value = status.connected;
  });
});

onUnmounted(() => {
  window.scannerAPI.removeListeners();
});

// 환전 완료 버튼 클릭 시 호출
async function completeExchange() {
  if (!scannerConnected.value) {
    alert('스캐너가 연결되지 않았습니다');
    return;
  }
  
  isScanning.value = true;
  
  try {
    const result = await window.scannerAPI.scan();
    
    if (result.ok) {
      // 환전 데이터에 신분증 정보 추가
      await submitExchangeWithIdentity(result);
    } else {
      alert(`스캔 실패: ${result.error}`);
    }
  } catch (err) {
    console.error('스캔 오류:', err);
  } finally {
    isScanning.value = false;
  }
}

function saveIdentityToExchange(result: ScanResult) {
  // 환전 데이터에 저장할 정보
  const identityData = {
    documentType: result.documentType,
    documentId: result.documentId,
    imagePath: result.imagePath,
    name: result.parsed?.fullName || result.parsed?.name,
    nationality: result.parsed?.nationality,
    scannedAt: result.timestamp
  };
  
  // API 호출하여 환전 거래에 신분증 정보 연결
  // ...
}
</script>

<template>
  <div class="exchange-complete">
    <!-- 스캐너 상태 표시 -->
    <div :class="['scanner-status', { connected: scannerConnected }]">
      {{ scannerConnected ? '스캐너 연결됨' : '스캐너 미연결' }}
    </div>
    
    <!-- 스캔 결과 미리보기 -->
    <div v-if="scanResult?.ok" class="scan-preview">
      <img :src="`file://${scanResult.imagePath}`" alt="스캔 이미지" />
      <div class="scan-info">
        <p>문서 종류: {{ scanResult.documentType }}</p>
        <p>이름: {{ scanResult.parsed?.fullName || scanResult.parsed?.name }}</p>
      </div>
    </div>
    
    <!-- 환전 완료 버튼 -->
    <button 
      @click="completeExchange" 
      :disabled="isScanning || !scannerConnected"
    >
      {{ isScanning ? '스캔 중...' : '신분증 스캔 후 환전 완료' }}
    </button>
  </div>
</template>
```

---

## ⚙️ 7단계: Vite 설정 주의사항

### `vite.config.ts`

```typescript
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';

export default defineConfig({
  plugins: [
    electron({
      entry: 'electron/main.ts',
      vite: {
        build: {
          rollupOptions: {
            // 네이티브 모듈 외부화 (번들링 제외)
            external: ['koffi', 'iconv-lite', 'electron']
          }
        }
      }
    })
  ]
});
```

### `electron-builder.yml`

```yaml
appId: com.exchange.pos
productName: 환전소 POS

files:
  - "dist/**/*"
  - "electron/**/*"

extraFiles:
  # DLL 파일들을 실행 파일과 같은 위치에 복사
  - from: "dlls/"
    to: "."
    filter:
      - "*.dll"

win:
  target: nsis
  icon: build/icon.ico
```

---

## 🔧 트러블슈팅

### 1. DLL 로드 실패
```
Error: DLL not found
```
- DLL 파일들이 올바른 경로에 있는지 확인
- 64bit DLL(QuantA64.dll)인지 확인 (Electron은 64bit)
- 모든 의존 DLL이 함께 있는지 확인

### 2. 스캐너 연결 실패
```
Device open failed, code: 199
```
- 스캐너 USB 연결 상태 확인
- 다른 프로그램이 스캐너를 사용 중인지 확인
- 드라이버 설치 여부 확인

### 3. OCR 결과가 비어있음
- `DefaultSetting()` 호출 후 스캔
- 스캔 후 충분한 대기 시간 (600ms) 확보
- 여러 번 OCR 읽기 재시도

### 4. 한글 깨짐
- `iconv-lite`로 CP949 → UTF-8 변환 필수
- 텍스트 파일 저장 시 BOM 추가 (`\ufeff`)

---

## 📞 API 요약

| API | 설명 | 반환 |
|-----|------|------|
| `scannerAPI.getStatus()` | 스캐너 상태 조회 | `{ connected, saveFolder }` |
| `scannerAPI.scan()` | 스캔 1회 실행 | `ScanResult` |
| `scannerAPI.reconnect()` | 스캐너 재연결 | `{ ok: boolean }` |
| `scannerAPI.startScanLoop()` | 자동 스캔 루프 시작 | `{ ok: boolean }` |
| `scannerAPI.stopScanLoop()` | 자동 스캔 루프 중지 | `{ ok: boolean }` |
| `scannerAPI.getScanLoopStatus()` | 루프 상태 조회 | `{ running, scannerConnected }` |
| `scannerAPI.onScanResult(cb)` | 스캔 결과 이벤트 | - |
| `scannerAPI.onStatusChange(cb)` | 상태 변경 이벤트 | - |

---

## 📌 참고 사항

1. **스캔 타이밍**: 환전 확정 버튼 클릭 시 스캔 실행
2. **저장 경로**: 환전 거래 ID와 연결하여 관리 권장
3. **보안**: 신분증 이미지는 민감 정보이므로 암호화 저장 고려
4. **로그**: 스캔 성공/실패 로그를 환전 거래 기록에 포함
