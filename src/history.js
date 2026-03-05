/**
 * 순위 이력 저장/불러오기
 * GCS FUSE 마운트 환경에서도 데이터 손실 방지
 */
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
const HISTORY_FILE = resolve(DATA_DIR, 'history.json');

// 메모리 캐시 — GCS FUSE 읽기 실패 시 데이터 손실 방지
let memoryCache = null;

/**
 * history.json을 읽어온다.
 * GCS FUSE 마운트 지연 대비 3회 재시도 + 메모리 캐시 폴백.
 */
export async function loadHistory() {
  for (let i = 0; i < 3; i++) {
    try {
      const raw = await readFile(HISTORY_FILE, 'utf-8');
      const data = JSON.parse(raw);
      const placeCount = Object.keys(data.places || {}).length;

      // 파일은 읽었지만 비어있고, 메모리 캐시에 데이터가 있으면 캐시 사용
      if (placeCount === 0 && memoryCache && Object.keys(memoryCache.places || {}).length > 0) {
        console.log('[history] 파일이 비어있음 → 메모리 캐시 사용');
        return memoryCache;
      }

      // 정상 데이터면 캐시 갱신
      if (placeCount > 0) {
        memoryCache = data;
      }
      return data;
    } catch (err) {
      if (i < 2) {
        console.log(`[history] 읽기 실패 (${i + 1}/3), 1초 후 재시도: ${err.message}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  // 3회 실패 → 메모리 캐시가 있으면 사용
  if (memoryCache) {
    console.log('[history] 파일 읽기 3회 실패 → 메모리 캐시 사용');
    return memoryCache;
  }

  return { places: {}, lastUpdated: null };
}

/**
 * 순위 결과를 저장한다.
 * 데이터 손실 방지: 기존 파일보다 업체 수가 줄어들면 덮어쓰지 않음.
 */
export async function saveResult(placeId, placeName, url, keyword, rankResult) {
  const history = await loadHistory();

  if (!history.places[placeId]) {
    history.places[placeId] = { placeId, placeName, url, keywords: {} };
  }

  // 업체명이 새로 확인되면 갱신
  if (placeName && rankResult.placeName) {
    history.places[placeId].placeName = rankResult.placeName;
  }

  if (!history.places[placeId].keywords[keyword]) {
    history.places[placeId].keywords[keyword] = { records: [] };
  }

  history.places[placeId].keywords[keyword].records.unshift({
    timestamp: new Date().toISOString(),
    rank: rankResult.rank,
    totalResults: rankResult.totalResults || null,
    matchedBy: rankResult.matchedBy || null,
  });

  // 키워드별 최대 100개 기록 유지
  history.places[placeId].keywords[keyword].records =
    history.places[placeId].keywords[keyword].records.slice(0, 100);

  history.lastUpdated = new Date().toISOString();

  // 안전장치: 기존 파일 크기 확인
  const newJson = JSON.stringify(history, null, 2);
  try {
    const fileStat = await stat(HISTORY_FILE);
    if (fileStat.size > 0 && newJson.length < fileStat.size * 0.5) {
      console.error(`[history] 데이터 손실 방지: 기존 ${fileStat.size}B → 새 ${newJson.length}B (50% 이상 감소, 저장 차단)`);
      return history;
    }
  } catch { /* 파일 없음 — 신규 생성 */ }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, newJson, 'utf-8');

  // 메모리 캐시 갱신
  memoryCache = history;

  return history;
}

/**
 * 이전 순위를 조회한다 (현재 저장 전 기준).
 */
export function getPreviousRank(history, placeId, keyword) {
  const records = history.places?.[placeId]?.keywords?.[keyword]?.records;
  if (!records || records.length === 0) return null;
  return records[0].rank;
}

/**
 * 특정 업체의 이력을 조회한다.
 * keyword가 주어지면 해당 키워드 기록만, 없으면 전체 키워드 요약.
 */
export function getPlaceHistory(history, placeId, keyword = null) {
  const place = history.places?.[placeId];
  if (!place) return null;

  if (keyword) {
    return place.keywords[keyword]?.records || [];
  }

  // 전체 키워드 요약
  return Object.entries(place.keywords).map(([kw, data]) => ({
    keyword: kw,
    latestRank: data.records[0]?.rank ?? null,
    previousRank: data.records[1]?.rank ?? null,
    recordCount: data.records.length,
    lastChecked: data.records[0]?.timestamp ?? null,
  }));
}
