/**
 * 네이버 검색광고 API를 통한 키워드 월간 검색량 조회
 * 환경변수: NAVER_AD_CUSTOMER_ID, NAVER_AD_API_KEY, NAVER_AD_SECRET_KEY
 */
import crypto from 'crypto';

const CUSTOMER_ID = process.env.NAVER_AD_CUSTOMER_ID || '';
const API_KEY = process.env.NAVER_AD_API_KEY || '';
const SECRET_KEY = process.env.NAVER_AD_SECRET_KEY || '';

// 캐시: keyword → { pc, mobile, updatedAt }
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

function generateSignature(timestamp, method, uri) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac('sha256', SECRET_KEY).update(message).digest('base64');
}

async function fetchBatch(keywords) {
  const timestamp = String(Date.now());
  const method = 'GET';
  const uri = '/keywordstool';
  const signature = generateSignature(timestamp, method, uri);

  const url = new URL('https://api.searchad.naver.com/keywordstool');
  url.searchParams.set('hintKeywords', keywords.join(','));
  url.searchParams.set('showDetail', '1');

  const resp = await fetch(url.toString(), {
    headers: {
      'X-Timestamp': timestamp,
      'X-API-KEY': API_KEY,
      'X-Customer': CUSTOMER_ID,
      'X-Signature': signature,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[searchVolume] API ${resp.status}: ${text}`);
    return;
  }

  const data = await resp.json();
  const kwSet = new Set(keywords.map(k => k.toLowerCase().replace(/\s+/g, '')));

  for (const item of (data.keywordList || [])) {
    const normalized = item.relKeyword.toLowerCase().replace(/\s+/g, '');
    if (kwSet.has(normalized)) {
      cache.set(item.relKeyword, {
        pc: item.monthlyPcQcCnt,
        mobile: item.monthlyMobileQcCnt,
        updatedAt: Date.now(),
      });
    }
  }
}

/**
 * 키워드 목록의 월간 검색량을 조회한다.
 * @param {string[]} keywords
 * @returns {Object|null} { keyword: { pc, mobile } } 또는 null (API 미설정시)
 */
export async function getSearchVolume(keywords) {
  if (!CUSTOMER_ID || !API_KEY || !SECRET_KEY) {
    return null;
  }

  // 캐시에 없거나 만료된 키워드만 조회
  const uncached = keywords.filter(kw => {
    const c = cache.get(kw);
    return !c || Date.now() - c.updatedAt > CACHE_TTL;
  });

  // 5개씩 배치 요청 (API 제한)
  for (let i = 0; i < uncached.length; i += 5) {
    const batch = uncached.slice(i, i + 5);
    try {
      await fetchBatch(batch);
    } catch (err) {
      console.error('[searchVolume] fetch error:', err.message);
    }
  }

  const result = {};
  for (const kw of keywords) {
    const c = cache.get(kw);
    result[kw] = c ? { pc: c.pc, mobile: c.mobile } : { pc: null, mobile: null };
  }
  return result;
}

export function isConfigured() {
  return !!(CUSTOMER_ID && API_KEY && SECRET_KEY);
}
