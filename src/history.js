/**
 * 순위 이력 저장/불러오기
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
const HISTORY_FILE = resolve(DATA_DIR, 'history.json');

/**
 * history.json을 읽어온다. 없으면 빈 구조 반환.
 */
export async function loadHistory() {
  try {
    const raw = await readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { places: {}, lastUpdated: null };
  }
}

/**
 * 순위 결과를 저장한다.
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

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');

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
