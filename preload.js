/**
 * Preload Script
 * Main Process와 Renderer 간 안전한 통신 브릿지
 */

const { contextBridge, ipcRenderer } = require('electron');

// Renderer에서 사용할 API 노출
contextBridge.exposeInMainWorld('scannerAPI', {
  // 상태 조회
  getStatus: () => ipcRenderer.invoke('get-status'),
  
  // 수동 스캔 트리거
  manualScan: () => ipcRenderer.invoke('manual-scan'),
  
  // 스캐너 재연결
  reconnectScanner: () => ipcRenderer.invoke('reconnect-scanner'),
  
  // 스캔 루프 제어 (페이지 진입/이탈 시 사용)
  startScanLoop: () => ipcRenderer.invoke('start-scan-loop'),
  stopScanLoop: () => ipcRenderer.invoke('stop-scan-loop'),
  getScanLoopStatus: () => ipcRenderer.invoke('get-scan-loop-status'),
  
  // 이벤트 리스너
  onScanResult: (callback) => {
    ipcRenderer.on('scan-result', (event, data) => callback(data));
  },
  
  onScannerStatus: (callback) => {
    ipcRenderer.on('scanner-status', (event, data) => callback(data));
  },
  
  // 리스너 제거
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});
