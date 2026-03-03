/**
 * 네이버 지도 검색 결과 크롤링
 *
 * 최적화 전략:
 * - 이미지/폰트/미디어 리소스 차단 → 메모리 절약 + 속도 향상
 * - allSearch API 인터셉트 (20건 즉시)
 * - Apollo State에서 70건 추출 (스크롤 불필요)
 * - 추가 페이지 필요 시에만 페이지 네비게이션
 */
import { chromium } from 'playwright';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── 브라우저 싱글턴 ───
let _browser = null;
let _closeTimer = null;
const IDLE_TIMEOUT = 60_000;

async function getBrowser(headless = true) {
  if (_browser && !_browser.isConnected()) _browser = null;
  if (_browser) {
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
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
  _browser.on('disconnected', () => { _browser = null; });
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
 * 리소스 차단이 적용된 새 페이지를 생성한다.
 */
async function createLightPage(context) {
  const page = await context.newPage();
  // 이미지/폰트/미디어 차단 → 속도 + 메모리 절약
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,eot,otf,mp4,mp3,webm}', route => route.abort());
  await page.route('**/{analytics,adservice,doubleclick,googlesyndication,googletagmanager}**', route => route.abort());
  return page;
}

/**
 * 네이버 지도에서 키워드 검색 후 플레이스 결과 목록을 반환한다.
 *
 * 1단계: allSearch API 인터셉트 (20건, ~3초)
 * 2단계: Apollo State에서 70건 추출 (스크롤 불필요, ~4초)
 * 3단계: 추가 페이지 필요 시 페이지 네비게이션
 */
export async function crawlNaverPlace(keyword, options = {}) {
  const { maxRank = 200, headless = true, lng = null, lat = null } = options;

  for (let retry = 0; retry < 2; retry++) {
    let context = null;
    try {
      const browser = await getBrowser(headless);
      context = await browser.newContext({
        userAgent: DEFAULT_UA,
        viewport: { width: 800, height: 600 },
        locale: 'ko-KR',
      });
      const page = await createLightPage(context);

      // allSearch API 응답 인터셉트
      let apiResults = [];
      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('api/search/allSearch')) {
          try {
            const data = await response.json();
            const list = data?.result?.place?.list;
            if (Array.isArray(list) && list.length > 0) {
              apiResults = list.map(item => ({
                placeId: String(item.id),
                placeName: item.name,
              }));
            }
          } catch { /* 무시 */ }
        }
      });

      // 네이버 지도 검색 페이지 접속
      let searchUrl = `https://map.naver.com/p/search/${encodeURIComponent(keyword)}`;
      if (lng && lat) {
        searchUrl += `?c=${lng},${lat},15,0,0,0,dh`;
      }
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // searchIframe + Apollo State 대기 (스크롤 불필요)
      let searchFrame = null;
      let apolloItems = [];

      for (let attempt = 0; attempt < 25; attempt++) {
        await page.waitForTimeout(400);

        if (!searchFrame) {
          searchFrame = page.frames().find(f =>
            f.name() === 'searchIframe' ||
            f.url().includes('pcmap.place.naver.com')
          );
        }

        if (searchFrame) {
          try {
            apolloItems = await searchFrame.evaluate(() => {
              const apollo = window.__APOLLO_STATE__;
              if (!apollo) return [];
              const rq = apollo['ROOT_QUERY'];
              if (!rq) return [];

              // 메인 리스트 키 찾기
              const listKey = Object.keys(rq).find(
                k => k.includes('restaurantList') && !k.includes('Filter') &&
                     (k.includes('"display":70') || k.includes('"display":50'))
              );
              if (!listKey) return [];

              const listData = rq[listKey];
              if (!listData?.items) return [];

              return listData.items.map(entry => {
                const ref = entry?.__ref;
                if (!ref) return null;
                const item = apollo[ref];
                if (!item || !item.name) return null;
                return {
                  placeName: item.name,
                  placeId: item.id ? String(item.id) : null,
                };
              }).filter(Boolean);
            });

            if (apolloItems.length > 0) break;
          } catch { /* 아직 준비 안됨 */ }
        }
      }

      // 결과 조합: Apollo(70건) > allSearch API(20건)
      let results = [];

      if (apolloItems.length > 0) {
        // Apollo 우선 (70건, placeId 포함)
        for (const item of apolloItems) {
          if (results.length >= maxRank) break;
          results.push({
            rank: results.length + 1,
            placeId: item.placeId,
            placeName: item.placeName,
          });
        }
      } else if (apiResults.length > 0) {
        // Apollo 실패 시 allSearch API 결과 사용 (20건)
        for (const item of apiResults) {
          if (results.length >= maxRank) break;
          results.push({
            rank: results.length + 1,
            placeId: item.placeId,
            placeName: item.placeName,
          });
        }
      }

      // 70건 이상 필요하면 추가 페이지 크롤링
      if (results.length < maxRank && searchFrame) {
        let currentPage = 1;
        const MAX_PAGES = 5;

        while (results.length < maxRank && currentPage < MAX_PAGES) {
          const hasNext = await clickNextPage(searchFrame, currentPage + 1);
          if (!hasNext) break;

          currentPage++;
          await page.waitForTimeout(2500);

          // 새 페이지의 Apollo State 추출
          const nextApollo = await collectApolloItems(searchFrame);
          if (nextApollo.length === 0) break;

          for (const item of nextApollo) {
            if (results.length >= maxRank) break;
            // 중복 제거
            if (!results.some(r => r.placeId && r.placeId === item.placeId)) {
              results.push({
                rank: results.length + 1,
                placeId: item.placeId,
                placeName: item.placeName,
              });
            }
          }
        }
      }

      await context.close().catch(() => {});

      console.log(`[crawl] ${keyword}: ${results.length}건 수집`);
      return results;
    } catch (err) {
      if (context) await context.close().catch(() => {});
      const msg = err.message || '';
      if (msg.includes('closed') || msg.includes('crashed') || msg.includes('disconnected')) {
        if (_browser) {
          await _browser.close().catch(() => {});
          _browser = null;
        }
        if (retry === 0) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      }
      console.error(`[crawl] ${keyword} 실패 (retry=${retry}):`, msg);
      return [];
    }
  }
  return [];
}

/**
 * Apollo State에서 결과 리스트를 추출한다.
 */
async function collectApolloItems(frame) {
  try {
    return await frame.evaluate(() => {
      const apollo = window.__APOLLO_STATE__;
      if (!apollo) return [];

      const rq = apollo['ROOT_QUERY'];
      if (!rq) return [];

      const listKey = Object.keys(rq).find(
        k => k.includes('restaurantList') && !k.includes('Filter') &&
             (k.includes('"display":70') || k.includes('"display":50'))
      );
      if (!listKey) return [];

      const listData = rq[listKey];
      if (!listData?.items) return [];

      return listData.items.map(entry => {
        const ref = entry?.__ref;
        if (!ref) return null;
        const item = apollo[ref];
        if (!item || !item.name) return null;
        return {
          placeName: item.name,
          placeId: item.id ? String(item.id) : null,
          isAd: false,
        };
      }).filter(Boolean);
    });
  } catch {
    return [];
  }
}

/**
 * 페이지 네비게이션에서 특정 페이지 버튼을 클릭한다.
 */
async function clickNextPage(frame, pageNum) {
  try {
    return await frame.evaluate((targetPage) => {
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
  } catch {
    return false;
  }
}

/**
 * Place ID로 업체명을 가져온다.
 * HTTP를 먼저 시도, 실패 시 Playwright 폴백.
 */
export async function fetchPlaceName(placeId) {
  // 1차: HTTP (빠르고 메모리 무사용)
  try {
    const res = await fetch(`https://pcmap.place.naver.com/restaurant/${placeId}/home`, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Accept': 'text/html',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    if (res.ok) {
      const html = await res.text();
      const ogMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
      if (ogMatch) {
        const parts = ogMatch[1].split(':');
        if (parts[0]?.trim()) return parts[0].trim();
      }
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) {
        const parts = titleMatch[1].split(':');
        if (parts[0]?.trim()) return parts[0].trim();
      }
    }
  } catch { /* 폴백 */ }

  // 2차: Playwright 폴백
  let context = null;
  try {
    const browser = await getBrowser(true);
    context = await browser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 800, height: 600 },
      locale: 'ko-KR',
    });
    const page = await createLightPage(context);
    await page.goto(`https://pcmap.place.naver.com/restaurant/${placeId}/home`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
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

    await context.close().catch(() => {});
    return name;
  } catch {
    if (context) await context.close().catch(() => {});
    return null;
  }
}

/**
 * 업체명으로 좌표를 추출한다.
 * allSearch API 인터셉트로 x,y 추출.
 */
export async function fetchPlaceCoords(placeId, placeName) {
  if (!placeName) return { lng: null, lat: null };

  let context = null;
  try {
    const browser = await getBrowser(true);
    context = await browser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 800, height: 600 },
      locale: 'ko-KR',
    });
    const page = await createLightPage(context);

    let foundCoords = null;
    page.on('response', async (response) => {
      if (response.url().includes('api/search/allSearch')) {
        try {
          const data = await response.json();
          const list = data?.result?.place?.list;
          if (Array.isArray(list)) {
            const match = list.find(item => String(item.id) === String(placeId));
            if (match?.x && match?.y) {
              foundCoords = { lng: String(match.x), lat: String(match.y) };
            }
            if (!foundCoords && list[0]?.x && list[0]?.y) {
              foundCoords = { lng: String(list[0].x), lat: String(list[0].y) };
            }
          }
        } catch { /* 무시 */ }
      }
    });

    await page.goto(
      `https://map.naver.com/p/search/${encodeURIComponent(placeName)}`,
      { waitUntil: 'domcontentloaded', timeout: 20000 }
    );

    // API 응답 대기 (최대 5초)
    for (let i = 0; i < 10 && !foundCoords; i++) {
      await page.waitForTimeout(500);
    }

    await context.close().catch(() => {});
    return foundCoords || { lng: null, lat: null };
  } catch {
    if (context) await context.close().catch(() => {});
    return { lng: null, lat: null };
  }
}

/**
 * naver.me 단축 URL을 리다이렉트 추적하여 실제 URL로 변환한다.
 */
export async function resolveRedirectUrl(shortUrl) {
  // HTTP 리다이렉트 추적 시도
  try {
    const res = await fetch(shortUrl, {
      headers: { 'User-Agent': DEFAULT_UA },
      redirect: 'follow',
    });
    if (res.url && res.url !== shortUrl) return res.url;
  } catch { /* 폴백 */ }

  // Playwright 폴백
  const browser = await getBrowser(true);
  const context = await browser.newContext({ userAgent: DEFAULT_UA });
  try {
    const page = await context.newPage();
    await page.goto(shortUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const finalUrl = page.url();
    await context.close().catch(() => {});
    return finalUrl;
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}
