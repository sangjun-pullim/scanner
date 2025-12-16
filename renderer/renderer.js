/**
 * Renderer Process
 * UI 로직 및 이벤트 핸들링
 */

// DOM 요소
const scannerStatusDot = document.getElementById('scannerStatus');
const scannerStatusText = document.getElementById('scannerStatusText');
const btnManualScan = document.getElementById('btnManualScan');
const btnReconnect = document.getElementById('btnReconnect');
const scanResult = document.getElementById('scanResult');
const waitingIndicator = document.getElementById('waitingIndicator');
const historyList = document.getElementById('historyList');

// 결과 표시 요소
const resultPassportNo = document.getElementById('resultPassportNo');
const resultName = document.getElementById('resultName');
const resultNationality = document.getElementById('resultNationality');
const resultBirthDate = document.getElementById('resultBirthDate');
const resultSex = document.getElementById('resultSex');
const resultExpiry = document.getElementById('resultExpiry');
const resultMrz = document.getElementById('resultMrz');

// 스캔 기록
let scanHistory = [];

/**
 * 초기화
 */
async function init() {
  // 초기 상태 조회
  try {
    const status = await window.scannerAPI.getStatus();
    updateScannerStatus(status.scannerConnected);
  } catch (err) {
    console.error('Failed to get status:', err);
  }
  
  // 이벤트 리스너 등록
  setupEventListeners();
  setupIPCListeners();
}

/**
 * 이벤트 리스너 설정
 */
function setupEventListeners() {
  btnManualScan.addEventListener('click', async () => {
    btnManualScan.disabled = true;
    btnManualScan.textContent = '스캔 중...';
    
    try {
      await window.scannerAPI.manualScan();
    } catch (err) {
      console.error('Manual scan failed:', err);
    }
    
    setTimeout(() => {
      btnManualScan.disabled = false;
      btnManualScan.textContent = '수동 스캔';
    }, 1000);
  });
  
  btnReconnect.addEventListener('click', async () => {
    btnReconnect.disabled = true;
    btnReconnect.textContent = '연결 중...';
    
    try {
      const result = await window.scannerAPI.reconnectScanner();
      updateScannerStatus(result.ok);
    } catch (err) {
      console.error('Reconnect failed:', err);
      updateScannerStatus(false);
    }
    
    setTimeout(() => {
      btnReconnect.disabled = false;
      btnReconnect.textContent = '재연결';
    }, 1000);
  });
}

/**
 * IPC 리스너 설정
 */
function setupIPCListeners() {
  // 스캔 결과 수신
  window.scannerAPI.onScanResult((data) => {
    console.log('Scan result:', data);
    
    if (data.ok) {
      displayScanResult(data);
      addToHistory(data);
    }
  });
  
  // 스캐너 상태 변경
  window.scannerAPI.onScannerStatus((data) => {
    updateScannerStatus(data.connected);
  });
}

/**
 * 스캐너 상태 UI 업데이트
 */
function updateScannerStatus(connected) {
  if (connected) {
    scannerStatusDot.classList.add('connected');
    scannerStatusText.textContent = '스캐너 연결됨';
    btnManualScan.disabled = false;
  } else {
    scannerStatusDot.classList.remove('connected');
    scannerStatusText.textContent = '스캐너 연결 안됨';
    btnManualScan.disabled = true;
  }
}

/**
 * 스캔 결과 표시
 */
function displayScanResult(data) {
  // 대기 화면 숨기고 결과 표시
  waitingIndicator.style.display = 'none';
  scanResult.classList.add('show');
  
  // 기본 정보
  resultPassportNo.textContent = data.passportNo || '-';
  
  // 파싱된 정보가 있으면 표시
  if (data.parsed) {
    resultName.textContent = data.parsed.fullName || '-';
    resultNationality.textContent = data.parsed.nationality || '-';
    resultBirthDate.textContent = data.parsed.birthDate || '-';
    resultSex.textContent = data.parsed.sex || '-';
    resultExpiry.textContent = data.parsed.expiryDate || '-';
  } else {
    resultName.textContent = '-';
    resultNationality.textContent = '-';
    resultBirthDate.textContent = '-';
    resultSex.textContent = '-';
    resultExpiry.textContent = '-';
  }
  
  // MRZ 원문
  if (data.mrz) {
    resultMrz.textContent = data.mrz.replace(/\n/g, '\n');
  } else {
    resultMrz.textContent = '-';
  }
}

/**
 * 히스토리에 추가
 */
function addToHistory(data) {
  const item = {
    passportNo: data.passportNo,
    name: data.parsed?.fullName || '',
    timestamp: data.timestamp || new Date().toISOString()
  };
  
  scanHistory.unshift(item);
  
  // 최대 50개 유지
  if (scanHistory.length > 50) {
    scanHistory = scanHistory.slice(0, 50);
  }
  
  renderHistory();
}

/**
 * 히스토리 렌더링
 */
function renderHistory() {
  historyList.innerHTML = scanHistory.map(item => {
    const time = new Date(item.timestamp).toLocaleString('ko-KR');
    return `
      <div class="history-item">
        <span class="passport-no">${item.passportNo}</span>
        <span class="time">${time}</span>
      </div>
    `;
  }).join('');
}

// 초기화 실행
init();
