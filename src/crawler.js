/**
 * Playwright 기반 네이버 지도 검색 결과 크롤링
 *
 * 전략:
 * 1단계: allSearch API 응답 인터셉트 → 첫 20개 결과에서 Place ID 매칭
 * 2단계: searchIframe DOM 스크롤 → 업체명 기반 매칭 (~60개)
 * 3단계: 페이지 네비게이션 클릭 → 추가 페이지 DOM 매칭
 *
 * 성능 최적화:
 * - 브라우저 인스턴스 재사용 (싱글턴)
 * - 탭(페이지)만 새로 열고 닫음
 * - 대기 시간 최적화
 */
import { chromium } from 'playwright';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── 브라우저 싱글턴 ───
let _browser = null;
let _closeTimer = null;
const IDLE_TIMEOUT = 60_000; // 60초 미사용 시 자동 종료

async function getBrowser(headless = true) {
  if (_browser && _browser.isConnected()) {
    resetCloseTimer();
    return _browser;
  }
  _browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--single-process',
      '--no-zygote',
    ],
  });
  resetCloseTimer();
  return _browser;
}

function resetCloseTimer() {
  if (_closeTimer) clearTimeout(_closeTimer);
  _closeTimer = setTimeout(async () => {
    if (_browser && _browser.isConnected()) {
      await _browser.close().catch(() => {});
      _browser = null;
    }
  }, IDLE_TIMEOUT);
}

export async function closeBrowser() {
  if (_closeTimer) clearTimeout(_closeTimer);
  if (_browser && _browser.isConnected()) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

/**
 * 네이버 지도에서 키워드 검색 후 플레이스 결과 목록을 반환한다.
 */
export async function crawlNaverPlace(keyword, options = {}) {
  const { maxRank = 50, headless = true } = options;

  const browser = await getBrowser(headless);
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

    // searchIframe이 로드될 때까지 대기
    let searchFrame = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      await page.waitForTimeout(500);
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

    // 현재 페이지 DOM에서 결과 수집
    const results = [];
    let currentPage = 1;
    const maxPages = Math.ceil(maxRank / 50);

    while (results.length < maxRank && currentPage <= Math.min(maxPages, 5)) {
      await scrollToBottom(searchFrame);
      const domItems = await collectDomItems(searchFrame);

      for (const item of domItems) {
        if (results.length >= maxRank) break;

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

      const hasNext = await clickNextPage(searchFrame, currentPage + 1);
      if (!hasNext) break;

      currentPage++;
      await page.waitForTimeout(1500);
    }

    const organicResults = results.filter(r => !r.isAd);
    return organicResults.map((r, i) => ({
      rank: i + 1,
      placeId: r.placeId,
      placeName: r.placeName,
    }));
  } finally {
    await context.close();
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

    await new Promise(r => setTimeout(r, 500));

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
      const nameEl = li.querySelector('span.TYaxT');
      if (!nameEl) continue;
      const placeName = nameEl.textContent?.trim() || '';
      if (!placeName) continue;

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
      const nav = document.querySelector('.zRM9F');
      if (!nav) return false;

      const buttons = nav.querySelectorAll('a.mBN2s');
      for (const btn of buttons) {
        if (btn.textContent?.trim() === String(targetPage)) {
          btn.click();
          return true;
        }
      }

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
 */
export async function fetchPlaceName(placeId) {
  const browser = await getBrowser(true);
  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  try {
    const url = `https://pcmap.place.naver.com/restaurant/${placeId}/home`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);

    const name = await page.evaluate(() => {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        const content = ogTitle.getAttribute('content') || '';
        const parts = content.split(':');
        if (parts[0]?.trim()) return parts[0].trim();
      }
      const title = document.title || '';
      if (title) {
        const parts = title.split(':');
        if (parts[0]?.trim()) return parts[0].trim();
      }
      const nameEl = document.querySelector('span.GHAhO, h2.tit');
      if (nameEl) return nameEl.textContent?.trim() || null;
      return null;
    });

    return name;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

/**
 * naver.me 단축 URL을 리다이렉트 추적하여 실제 URL로 변환한다.
 */
export async function resolveRedirectUrl(shortUrl) {
  const browser = await getBrowser(true);
  const page = await browser.newPage();
  try {
    await page.goto(shortUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return page.url();
  } finally {
    await page.close();
  }
}
