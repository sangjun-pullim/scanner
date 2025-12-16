/**
 * USB 장치 연결/해제 모니터링 모듈
 */

const EventEmitter = require('events');

// usb-detection은 optional dependency로 처리
let usbDetect = null;
try {
  usbDetect = require('usb-detection');
} catch (err) {
  console.warn('[USB] usb-detection module not available, using polling fallback');
}

/**
 * USB 모니터 클래스
 * 스캐너 연결/해제 이벤트 발생
 */
class UsbMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // QuantA6 스캐너 VID/PID (실제 값으로 변경 필요)
    this.vendorId = options.vendorId || null;
    this.productId = options.productId || null;
    
    this.isMonitoring = false;
    this.pollInterval = null;
    this.lastConnected = false;
    this.checkDevice = options.checkDevice || null; // 장치 확인 콜백
  }
  
  /**
   * 모니터링 시작
   */
  start() {
    if (this.isMonitoring) return;
    this.isMonitoring = true;
    
    if (usbDetect && this.vendorId) {
      // usb-detection 사용 (VID/PID 지정된 경우)
      this._startNativeMonitoring();
    } else {
      // 폴링 방식 fallback
      this._startPollingMonitoring();
    }
    
    console.log('[USB] Monitoring started');
  }
  
  /**
   * 모니터링 중지
   */
  stop() {
    if (!this.isMonitoring) return;
    this.isMonitoring = false;
    
    if (usbDetect) {
      try {
        usbDetect.stopMonitoring();
      } catch (err) {
        // 무시
      }
    }
    
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    
    console.log('[USB] Monitoring stopped');
  }
  
  /**
   * 네이티브 USB 이벤트 모니터링
   */
  _startNativeMonitoring() {
    usbDetect.startMonitoring();
    
    // 특정 VID/PID 장치 연결 감지
    if (this.vendorId && this.productId) {
      usbDetect.on(`add:${this.vendorId}:${this.productId}`, (device) => {
        console.log('[USB] Scanner connected:', device);
        this.emit('connected', device);
      });
      
      usbDetect.on(`remove:${this.vendorId}:${this.productId}`, (device) => {
        console.log('[USB] Scanner disconnected:', device);
        this.emit('disconnected', device);
      });
    } else if (this.vendorId) {
      // VID만 지정된 경우
      usbDetect.on(`add:${this.vendorId}`, (device) => {
        console.log('[USB] Device connected:', device);
        this.emit('connected', device);
      });
      
      usbDetect.on(`remove:${this.vendorId}`, (device) => {
        console.log('[USB] Device disconnected:', device);
        this.emit('disconnected', device);
      });
    } else {
      // 모든 USB 장치 감지
      usbDetect.on('add', (device) => {
        this.emit('connected', device);
      });
      
      usbDetect.on('remove', (device) => {
        this.emit('disconnected', device);
      });
    }
  }
  
  /**
   * 폴링 방식 모니터링 (fallback)
   * checkDevice 콜백을 주기적으로 호출하여 장치 상태 확인
   */
  _startPollingMonitoring() {
    if (!this.checkDevice) {
      console.warn('[USB] No checkDevice callback provided for polling');
      return;
    }
    
    // 500ms 간격으로 폴링
    this.pollInterval = setInterval(() => {
      const isConnected = this.checkDevice();
      
      if (isConnected !== this.lastConnected) {
        if (isConnected) {
          console.log('[USB] Scanner connected (polling)');
          this.emit('connected', null);
        } else {
          console.log('[USB] Scanner disconnected (polling)');
          this.emit('disconnected', null);
        }
        this.lastConnected = isConnected;
      }
    }, 500);
  }
  
  /**
   * 현재 연결된 장치 목록 조회
   */
  async listDevices() {
    if (!usbDetect) return [];
    
    return new Promise((resolve) => {
      usbDetect.find((err, devices) => {
        if (err) {
          console.error('[USB] List error:', err);
          resolve([]);
        } else {
          resolve(devices || []);
        }
      });
    });
  }
  
  /**
   * 특정 VID/PID 장치 찾기
   */
  async findDevice(vendorId, productId) {
    if (!usbDetect) return null;
    
    return new Promise((resolve) => {
      usbDetect.find(vendorId, productId, (err, devices) => {
        if (err || !devices || devices.length === 0) {
          resolve(null);
        } else {
          resolve(devices[0]);
        }
      });
    });
  }
}

module.exports = UsbMonitor;
