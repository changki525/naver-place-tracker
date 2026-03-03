/**
 * Playwright 기반 네이버 지도 검색 결과 크롤링
 *
 * 전략:
 * 1단계: allSearch API 응답 인터셉트 → 첫 20개 결과에서 Place ID 매칭
 * 2단계: searchIframe DOM 스크롤 → 업체명 기반 매칭 (~60개)
 * 3단계: 페이지 네비게이션 클릭 → 추가 페이지 DOM 매칭
 */
import { chromium } from 'playwright';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 네이버 지도에서 키워드 검색 후 플레이스 결과 목록을 반환한다.
 *
 * @param {string} keyword 검색 키워드
 * @param {object} options
 * @param {number} [options.maxRank=50] 최대 탐색 순위
 * @param {boolean} [options.headless=true] 헤드리스 모드
 * @returns {Promise<Array<{rank: number, placeId: string|null, placeName: string}>>}
 */
export async function crawlNaverPlace(keyword, options = {}) {
  const { maxRank = 50, headless = true } = options;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  try {
    // allSearch API 응답 인터셉트
    let apiResults = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('api/search/allSearch')) {
        try {
          const data = await response.json();
          const list = data?.result?.place?.list;
          if (Array.isArray(list) && list.length > 0) {
            apiResults = list.map((item, i) => ({
              placeId: String(item.id),
              placeName: item.name,
            }));
          }
        } catch { /* 무시 */ }
      }
    });

    // 네이버 지도 검색 페이지 접속
    const searchUrl = `https://map.naver.com/p/search/${encodeURIComponent(keyword)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // searchIframe이 로드될 때까지 대기 (프레임 + 콘텐츠)
    let searchFrame = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.waitForTimeout(1000);
      searchFrame = page.frames().find(f =>
        f.name() === 'searchIframe' ||
        f.url().includes('pcmap.place.naver.com')
      );
      if (searchFrame) {
        try {
          const hasResults = await searchFrame.evaluate(() =>
            document.querySelectorAll('li.UEzoS').length > 0
          );
          if (hasResults) break;
        } catch { /* 프레임 아직 준비 안됨 */ }
      }
    }

    if (!searchFrame) return [];

    // 1단계: 현재 페이지 DOM에서 결과 수집
    const results = [];
    let currentPage = 1;
    const maxPages = Math.ceil(maxRank / 50); // 대략 페이지당 50개

    while (results.length < maxRank && currentPage <= Math.min(maxPages, 5)) {
      // DOM 스크롤로 현재 페이지의 모든 아이템 로드
      await scrollToBottom(searchFrame);

      // DOM에서 결과 수집
      const domItems = await collectDomItems(searchFrame);

      for (const item of domItems) {
        if (results.length >= maxRank) break;

        // API 데이터에서 ID 매칭 (첫 페이지만)
        let placeId = null;
        if (currentPage === 1 && apiResults.length > 0) {
          const apiMatch = apiResults.find(
            a => a.placeName === item.placeName
          );
          if (apiMatch) {
            placeId = apiMatch.placeId;
          }
        }

        results.push({
          rank: results.length + 1,
          placeId,
          placeName: item.placeName,
          isAd: item.isAd,
        });
      }

      if (results.length >= maxRank) break;

      // 다음 페이지로 이동
      const hasNext = await clickNextPage(searchFrame, currentPage + 1);
      if (!hasNext) break;

      currentPage++;
      await page.waitForTimeout(2000);
    }

    // 광고 제외한 결과만 반환 (순위 재정렬)
    const organicResults = results.filter(r => !r.isAd);
    return organicResults.map((r, i) => ({
      rank: i + 1,
      placeId: r.placeId,
      placeName: r.placeName,
    }));
  } finally {
    await browser.close();
  }
}

/**
 * searchIframe을 맨 아래까지 스크롤한다.
 */
async function scrollToBottom(frame) {
  let prevHeight = 0;
  let attempts = 0;

  while (attempts < 10) {
    const scrollInfo = await frame.evaluate(() => {
      const sc = document.querySelector('#_pcmap_list_scroll_container');
      if (!sc) return { scrolled: false };
      sc.scrollTop = sc.scrollHeight;
      return { scrolled: true, scrollHeight: sc.scrollHeight };
    });

    if (!scrollInfo.scrolled) break;

    await new Promise(r => setTimeout(r, 800));

    if (scrollInfo.scrollHeight === prevHeight) break;
    prevHeight = scrollInfo.scrollHeight;
    attempts++;
  }
}

/**
 * 현재 searchIframe DOM에서 업체 목록을 수집한다.
 */
async function collectDomItems(frame) {
  return frame.evaluate(() => {
    const items = [];
    const lis = document.querySelectorAll('li.UEzoS');

    for (const li of lis) {
      // 업체명 추출
      const nameEl = li.querySelector('span.TYaxT');
      if (!nameEl) continue;
      const placeName = nameEl.textContent?.trim() || '';
      if (!placeName) continue;

      // 광고 여부 확인
      const isAd = !!(
        li.querySelector('.cZnHG') ||
        li.querySelector('[class*="icon_ad"]') ||
        li.getAttribute('data-laim-exp-id')?.includes('*e')
      );

      items.push({ placeName, isAd });
    }

    return items;
  });
}

/**
 * 페이지 네비게이션에서 특정 페이지 버튼을 클릭한다.
 */
async function clickNextPage(frame, pageNum) {
  try {
    const clicked = await frame.evaluate((targetPage) => {
      // .zRM9F 는 페이지 네비게이션 컨테이너
      const nav = document.querySelector('.zRM9F');
      if (!nav) return false;

      const buttons = nav.querySelectorAll('a.mBN2s');
      for (const btn of buttons) {
        if (btn.textContent?.trim() === String(targetPage)) {
          btn.click();
          return true;
        }
      }

      // 다음페이지 버튼 시도
      const nextBtn = nav.querySelector('a.eUTV2:last-child');
      if (nextBtn && !nextBtn.getAttribute('aria-disabled')) {
        nextBtn.click();
        return true;
      }

      return false;
    }, pageNum);

    return clicked;
  } catch {
    return false;
  }
}

/**
 * Place URL에서 업체명을 가져온다.
 * @param {string} placeId
 * @returns {Promise<string|null>}
 */
export async function fetchPlaceName(placeId) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  try {
    const url = `https://pcmap.place.naver.com/restaurant/${placeId}/home`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // 업체명 추출
    const name = await page.evaluate(() => {
      // 방법 1: og:title
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        const content = ogTitle.getAttribute('content') || '';
        // "업체명 : 네이버" 형식에서 업체명만 추출
        const parts = content.split(':');
        if (parts[0]?.trim()) return parts[0].trim();
      }
      // 방법 2: 타이틀 태그
      const title = document.title || '';
      if (title) {
        const parts = title.split(':');
        if (parts[0]?.trim()) return parts[0].trim();
      }
      // 방법 3: span.GHAhO (업체명 요소)
      const nameEl = document.querySelector('span.GHAhO, h2.tit');
      if (nameEl) return nameEl.textContent?.trim() || null;
      return null;
    });

    return name;
  } catch {
    return null;
  } finally {
    await browser.close();
  }
}

/**
 * naver.me 단축 URL을 리다이렉트 추적하여 실제 URL로 변환한다.
 * @param {string} shortUrl
 * @returns {Promise<string>}
 */
export async function resolveRedirectUrl(shortUrl) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(shortUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return page.url();
  } finally {
    await browser.close();
  }
}
