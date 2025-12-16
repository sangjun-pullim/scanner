/**
 * MRZ (Machine Readable Zone) 파서
 * ICAO 9303 표준 기반
 */

/**
 * MRZ 문자열 정규화 (TD3 형식: 44자 x 2줄)
 * @param {string} mrzRaw - 원본 MRZ 텍스트
 * @returns {object|null} { line1, line2 } 또는 null
 */
function normalizeMrz(mrzRaw) {
  if (!mrzRaw || typeof mrzRaw !== 'string') return null;
  
  // 제어 문자 제거
  let cleaned = mrzRaw.replace(/[\u0000-\u001F]/g, '');
  cleaned = cleaned.replace(/\r/g, '').trim();
  
  // 공백을 '<'로 변환
  cleaned = cleaned.replace(/ /g, '<');
  
  // MRZ 허용 문자만 (대문자, 숫자, '<', 개행)
  cleaned = cleaned.replace(/[^A-Z0-9<\n]/g, '');
  
  // 줄 단위로 분리
  const parts = cleaned.split('\n').filter(s => s.length > 0);
  
  if (parts.length >= 2) {
    // 2줄 이상이면 각각 44자로 처리
    let line1 = parts[0].padEnd(44, '<');
    let line2 = parts[1].padEnd(44, '<');
    
    return {
      line1: line1.substring(0, 44),
      line2: line2.substring(0, 44)
    };
  }
  
  // 개행 없이 연결된 경우
  cleaned = cleaned.replace(/\n/g, '');
  
  if (cleaned.length >= 88) {
    // 정상: 88자 이상
    return {
      line1: cleaned.substring(0, 44),
      line2: cleaned.substring(44, 88)
    };
  } else if (cleaned.length >= 44) {
    // 손상된 MRZ (구멍 등): 최선을 다해 파싱
    // 여권번호는 보통 Line2 시작 부분에 있음
    // 'P'로 시작하면 Line1, 국가코드(3자리 대문자)+숫자 패턴이 Line2 시작
    const line2Start = cleaned.search(/[A-Z]{1,2}\d{5,}/);
    if (line2Start > 0) {
      return {
        line1: cleaned.substring(0, line2Start).padEnd(44, '<'),
        line2: cleaned.substring(line2Start).padEnd(44, '<')
      };
    }
    // 그래도 못 찾으면 44자 기준으로 분할
    return {
      line1: cleaned.substring(0, 44).padEnd(44, '<'),
      line2: cleaned.substring(44).padEnd(44, '<')
    };
  }
  
  return null;
}

/**
 * MRZ 문자 값 계산 (ICAO 9303)
 * @param {string} char - 단일 문자
 * @returns {number} 문자 값
 */
function mrzCharValue(char) {
  if (char >= '0' && char <= '9') return char.charCodeAt(0) - '0'.charCodeAt(0);
  if (char >= 'A' && char <= 'Z') return char.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
  if (char === '<') return 0;
  return 0;
}

/**
 * MRZ 체크섬 계산
 * @param {string} str - 체크섬 계산할 문자열
 * @returns {number} 체크섬 값 (0-9)
 */
function mrzChecksum(str) {
  const weights = [7, 3, 1];
  let sum = 0;
  
  for (let i = 0; i < str.length; i++) {
    sum += mrzCharValue(str[i]) * weights[i % 3];
  }
  
  return sum % 10;
}

/**
 * 여권번호 추출 (TD3 형식)
 * Line2[0..8] = 여권번호 9자리, Line2[9] = 체크디지트
 * @param {string} mrzRaw - 원본 MRZ 텍스트
 * @returns {string|null} 여권번호
 */
function extractPassportNo(mrzRaw) {
  const normalized = normalizeMrz(mrzRaw);
  if (!normalized) return null;
  
  const { line2 } = normalized;
  
  // 여권번호 9자리 추출
  const passportField = line2.substring(0, 9);
  const checkDigit = line2[9];
  
  // '<' 제거하여 실제 번호 추출
  const passportNo = passportField.replace(/</g, '').toUpperCase();
  
  // 체크섬 검증 (불일치해도 번호는 반환)
  const calculatedCheck = mrzChecksum(passportField);
  if (checkDigit >= '0' && checkDigit <= '9') {
    const givenCheck = parseInt(checkDigit, 10);
    if (givenCheck !== calculatedCheck) {
      console.log(`[MRZ] Passport checksum mismatch: got ${checkDigit}, expected ${calculatedCheck}`);
    }
  }
  
  return passportNo || null;
}

/**
 * MRZ에서 전체 정보 파싱 (TD3 여권 형식)
 * @param {string} mrzRaw - 원본 MRZ 텍스트
 * @returns {object|null} 파싱된 정보
 */
function parseMrzFull(mrzRaw) {
  const normalized = normalizeMrz(mrzRaw);
  if (!normalized) return null;
  
  const { line1, line2 } = normalized;
  
  try {
    // Line 1 파싱
    const documentType = line1.substring(0, 2).replace(/</g, '');
    const issuingCountry = line1.substring(2, 5).replace(/</g, '');
    
    // 이름 파싱 (성<<이름)
    const namePart = line1.substring(5, 44);
    const nameSplit = namePart.split('<<');
    const surname = (nameSplit[0] || '').replace(/</g, ' ').trim();
    const givenNames = (nameSplit[1] || '').replace(/</g, ' ').trim();
    
    // Line 2 파싱
    const passportNo = line2.substring(0, 9).replace(/</g, '');
    const passportCheckDigit = line2[9];
    const nationality = line2.substring(10, 13).replace(/</g, '');
    const birthDate = line2.substring(13, 19); // YYMMDD
    const birthCheckDigit = line2[19];
    const sex = line2[20];
    const expiryDate = line2.substring(21, 27); // YYMMDD
    const expiryCheckDigit = line2[27];
    const personalNo = line2.substring(28, 42).replace(/</g, '');
    const personalCheckDigit = line2[42];
    const finalCheckDigit = line2[43];
    
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
      personalNo,
      raw: {
        line1,
        line2
      }
    };
  } catch (err) {
    console.error('[MRZ] Parse error:', err.message);
    return null;
  }
}

/**
 * MRZ 날짜 형식 변환 (YYMMDD -> YYYY-MM-DD)
 * @param {string} dateStr - YYMMDD 형식
 * @returns {string} YYYY-MM-DD 형식
 */
function formatMrzDate(dateStr) {
  if (!dateStr || dateStr.length !== 6) return '';
  
  let year = parseInt(dateStr.substring(0, 2), 10);
  const month = dateStr.substring(2, 4);
  const day = dateStr.substring(4, 6);
  
  // 2000년대 vs 1900년대 판단 (50 기준)
  year = year > 50 ? 1900 + year : 2000 + year;
  
  return `${year}-${month}-${day}`;
}

module.exports = {
  normalizeMrz,
  mrzChecksum,
  mrzCharValue,
  extractPassportNo,
  parseMrzFull,
  formatMrzDate
};
