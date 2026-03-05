/**
 * Place ID 추출 및 순위 매칭 로직
 */

/**
 * 다양한 네이버 지도 URL에서 Place ID를 추출한다.
 * @param {string} url
 * @returns {string|null} 숫자 문자열 ID 또는 null
 */
export function extractPlaceId(url) {
  if (!url) return null;

  // 모든 네이버 플레이스 URL 형식 지원:
  // https://map.naver.com/p/entry/place/123456789
  // https://map.naver.com/v5/search/.../place/123456789
  // https://m.place.naver.com/restaurant/123456789/home
  // https://m.place.naver.com/hairshop/123456789
  // https://pcmap.place.naver.com/cafe/123456789
  // 등 모든 카테고리 (place, restaurant, cafe, hairshop, hospital, accommodation, ...)
  const match = url.match(/\/(?:place|restaurant|cafe|hairshop|hospital|accommodation|beauty|food|shopping|leisure|attraction|culture|parking|gasstation|pharmacy|school)\/(\d+)/);
  if (match) return match[1];

  // 포괄적 폴백: naver.com URL에서 /카테고리/숫자 패턴
  const fallbackMatch = url.match(/naver\.com\/\w+\/(\d{5,})/);
  if (fallbackMatch) return fallbackMatch[1];

  // naver.me 단축 URL → 리다이렉트 필요
  if (url.includes('naver.me')) return null;

  return null;
}

/**
 * 업체명을 정규화한다 (비교용).
 * @param {string} name
 * @returns {string}
 */
export function normalizePlaceName(name) {
  if (!name) return '';
  return name
    .replace(/\s+/g, '')
    .replace(/[·\-_()（）「」【】]/g, '')
    .toLowerCase();
}

/**
 * 크롤링 결과에서 대상 업체의 순위를 찾는다.
 * 3단계 매칭: placeId → 정확한 이름 → 부분 이름
 *
 * @param {Array<{rank: number, placeId: string|null, placeName: string}>} results
 * @param {string|null} targetPlaceId
 * @param {string|null} targetPlaceName
 * @returns {{found: boolean, rank: number|null, matchedBy: string|null, placeName: string, placeId: string|null, totalResults: number}}
 */
export function parseRankFromResults(results, targetPlaceId, targetPlaceName) {
  const totalResults = results.length;

  // 1단계: Place ID 매칭 (가장 정확)
  if (targetPlaceId) {
    const byId = results.find(r => r.placeId === targetPlaceId);
    if (byId) {
      return {
        found: true,
        rank: byId.rank,
        matchedBy: 'placeId',
        placeName: byId.placeName,
        placeId: byId.placeId,
        totalResults,
      };
    }
  }

  // 2단계: 정확한 이름 매칭
  if (targetPlaceName) {
    const normalized = normalizePlaceName(targetPlaceName);
    const byExact = results.find(
      r => normalizePlaceName(r.placeName) === normalized
    );
    if (byExact) {
      return {
        found: true,
        rank: byExact.rank,
        matchedBy: 'exactName',
        placeName: byExact.placeName,
        placeId: byExact.placeId,
        totalResults,
      };
    }

    // 3단계: 부분 이름 매칭 (contains)
    const byPartial = results.find(r => {
      const n = normalizePlaceName(r.placeName);
      return n.includes(normalized) || normalized.includes(n);
    });
    if (byPartial) {
      return {
        found: true,
        rank: byPartial.rank,
        matchedBy: 'partialName',
        placeName: byPartial.placeName,
        placeId: byPartial.placeId,
        totalResults,
      };
    }
  }

  return {
    found: false,
    rank: null,
    matchedBy: null,
    placeName: targetPlaceName || '',
    placeId: targetPlaceId,
    totalResults,
  };
}
