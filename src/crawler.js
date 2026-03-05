/**
 * 네이버 플레이스 검색 결과 크롤링
 *
 * 전략: 네이버 플레이스 리스트 (앱/더보기와 동일한 순위)
 *
 * 1차) m.place.naver.com/{category}/list — 플레이스 리스트
 *   - 네이버 앱에서 보는 순위와 동일
 *   - 100개+ 한 번에 로드
 *   - 카테고리 자동 감지: m.search → 더보기 링크에서 추출
 *   - 좌표 미주입 (순위 왜곡 방지)
 *
 * 2차) map.naver.com/p/search — PC 지도 (폴백)
 *   - 플레이스 리스트 실패 시 사용
 *   - 페이지당 ~54개 오가닉, 최대 5페이지 = ~200개
 *
 * 봇 탐지 우회: playwright-extra + stealth 플러그인
 */
import { chromium as _chromium, devices } from 'playwright';

// Stealth 플러그인 (설치된 경우에만 사용)
let chromium = _chromium;
try {
  const { chromium: stealthChromium } = await import('playwright-extra');
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  stealthChromium.use(StealthPlugin());
  chromium = stealthChromium;
  console.log('[crawler] stealth 플러그인 활성화');
} catch {
  console.log('[crawler] stealth 미설치, 기본 playwright 사용');
}

const MOBILE_DEVICE = devices['iPhone 13'];

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
 * 리소스 차단이 적용된 경량 페이지 생성.
 */
async function createLightPage(context) {
  const page = await context.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,eot,otf,mp4,mp3,webm}', r => r.abort());
  await page.route('**/{analytics,adservice,doubleclick,googlesyndication,googletagmanager}**', r => r.abort());
  return page;
}

// ═══════════════════════════════════════════════════
// 메인 크롤링 함수
// ═══════════════════════════════════════════════════

/**
 * 네이버에서 키워드 검색 후 플레이스 결과 목록을 반환한다.
 * 플레이스 리스트 (앱과 동일) → PC 지도 폴백.
 */
export async function crawlNaverPlace(keyword, options = {}) {
  const { maxRank = 200, headless = true, lng = null, lat = null } = options;

  // 1차: 네이버 플레이스 리스트 (앱/더보기와 동일한 순위)
  const listResults = await crawlPlaceList(keyword, { maxRank, headless });
  if (listResults.length > 0) {
    console.log(`[crawl] ${keyword}: ${listResults.length}건 (플레이스 리스트)`);
    return listResults;
  }

  // 2차: PC 지도 폴백
  console.log(`[crawl] ${keyword}: 리스트 실패 → PC 지도 폴백`);
  const pcResults = await crawlPcMap(keyword, { maxRank, headless, lng, lat });
  console.log(`[crawl] ${keyword}: ${pcResults.length}건 (PC)`);
  return pcResults;
}

// ═══════════════════════════════════════════════════
// 네이버 플레이스 리스트 크롤링 (앱/더보기와 동일)
// ═══════════════════════════════════════════════════

/**
 * m.place.naver.com/{category}/list 에서 전체 리스트를 수집한다.
 * 네이버 앱에서 보는 순위와 동일.
 * 좌표 미주입 → 순위 왜곡 없음.
 *
 * 1단계: m.search.naver.com 검색 → 더보기 링크에서 카테고리 추출
 * 2단계: m.place.naver.com/{category}/list?query=... 에서 전체 수집
 */
async function crawlPlaceList(keyword, options) {
  const { maxRank = 200, headless = true } = options;

  for (let retry = 0; retry < 2; retry++) {
    let context = null;
    try {
      const browser = await getBrowser(headless);
      context = await browser.newContext({
        ...MOBILE_DEVICE,
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
      });
      const page = await createLightPage(context);

      // 1단계: 모바일 검색 → 카테고리 추출
      await page.goto(
        `https://m.search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`,
        { waitUntil: 'domcontentloaded', timeout: 30000 }
      );
      await page.waitForTimeout(2500);

      const category = await page.evaluate(() => {
        const links = document.querySelectorAll('a');
        for (const a of links) {
          const href = a.href || '';
          if (href.includes('m.place.naver.com') && href.includes('/list')) {
            const match = href.match(/m\.place\.naver\.com\/(\w+)\/list/);
            return match ? match[1] : null;
          }
          if (href.includes('m.place.naver.com')) {
            const match = href.match(/m\.place\.naver\.com\/(\w+)\//);
            if (match) return match[1];
          }
        }
        return null;
      });

      if (!category) {
        await context.close().catch(() => {});
        return [];
      }

      // 2단계: 플레이스 리스트 페이지 (좌표 미주입)
      const listUrl = `https://m.place.naver.com/${category}/list?query=${encodeURIComponent(keyword)}`;
      console.log(`[crawl-list] ${keyword}: ${category}/list`);
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // 스크롤로 전체 로드
      let prevCount = 0;
      for (let i = 0; i < 15; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(600);
        const curCount = await page.evaluate(() =>
          document.querySelectorAll('li.UEzoS, li.p0FrU').length
        );
        if (curCount === prevCount && i > 3) break;
        prevCount = curCount;
      }

      // DOM 수집
      const items = await page.evaluate(() => {
        const results = [];
        const seenSet = new Set();

        // li.UEzoS (맛집/카페)
        const lis1 = document.querySelectorAll('li.UEzoS');
        for (const li of lis1) {
          const nameEl = li.querySelector('span.TYaxT');
          if (!nameEl) continue;
          const placeName = nameEl.textContent?.trim() || '';
          if (!placeName || seenSet.has(placeName)) continue;
          seenSet.add(placeName);

          const isAd = !!(
            li.querySelector('.cZnHG') ||
            li.querySelector('[class*="icon_ad"]') ||
            (li.getAttribute('data-laim-exp-id') || '').includes('*e')
          );

          let placeId = null;
          const link = li.querySelector('a[href*="/place/"], a[href*="/restaurant/"], a[href*="/cafe/"], a[href*="/hairshop/"], a[href*="/hospital/"]');
          if (link) {
            const m = link.href.match(/\/(\d{5,})/);
            if (m) placeId = m[1];
          }
          results.push({ placeName, isAd, placeId });
        }

        // li.p0FrU (미용실/병원)
        if (results.length === 0) {
          const lis2 = document.querySelectorAll('li.p0FrU');
          for (const li of lis2) {
            const bluelink = li.querySelector('.place_bluelink');
            if (!bluelink) continue;
            let placeName = '';
            for (const child of bluelink.childNodes) {
              if (child.nodeType === 3) {
                const t = child.textContent?.trim();
                if (t) { placeName = t; break; }
              }
            }
            if (!placeName) {
              const firstChild = bluelink.querySelector('span, strong');
              placeName = firstChild?.textContent?.trim() || bluelink.textContent?.split(/네이버|예약|쿠폰|톡톡/)[0]?.trim() || '';
            }
            if (!placeName || seenSet.has(placeName)) continue;
            seenSet.add(placeName);

            const isAd = !!(
              li.textContent?.includes('광고') &&
              (li.querySelector('[class*="ad"]') || li.querySelector('[class*="Ad"]'))
            );

            let placeId = null;
            const link = li.querySelector('a[href*="/hairshop/"], a[href*="/hospital/"], a[href*="/place/"], a[href*="/restaurant/"]');
            if (link) {
              const m = link.href.match(/\/(\d{5,})/);
              if (m) placeId = m[1];
            }
            results.push({ placeName, isAd, placeId });
          }
        }

        return results;
      });

      await context.close().catch(() => {});

      if (items.length === 0) return [];

      // 중복 제거 + 오가닉 필터
      const results = [];
      let organicCount = 0;
      const seenIds = new Set();
      const seenNames = new Set();

      for (const item of items) {
        if (organicCount >= maxRank) break;
        if (item.isAd) continue;
        const idKey = item.placeId || null;
        const nameKey = item.placeName;
        if ((idKey && seenIds.has(idKey)) || seenNames.has(nameKey)) continue;
        if (idKey) seenIds.add(idKey);
        seenNames.add(nameKey);
        organicCount++;
        results.push({
          rank: organicCount,
          placeId: item.placeId || null,
          placeName: item.placeName,
        });
      }

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
      console.error(`[crawl-list] ${keyword} 실패:`, msg);
      return [];
    }
  }
  return [];
}

// ═══════════════════════════════════════════════════
// PC 지도 크롤링 (폴백)
// ═══════════════════════════════════════════════════

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * PC 네이버 지도에서 키워드 검색 후 플레이스 결과 목록을 반환한다.
 * DOM 순서 = 실제 화면 순서 = 정확한 순위.
 */
async function crawlPcMap(keyword, options) {
  const { maxRank = 200, headless = true, lng = null, lat = null } = options;

  for (let retry = 0; retry < 2; retry++) {
    let context = null;
    try {
      const browser = await getBrowser(headless);
      context = await browser.newContext({
        userAgent: DEFAULT_UA,
        viewport: { width: 1920, height: 1080 },
        locale: 'ko-KR',
      });
      const page = await createLightPage(context);

      // API 인터셉션 — placeId 보충용
      const apiItems = [];
      page.on('response', async (response) => {
        if (response.url().includes('api/search/allSearch')) {
          try {
            const data = await response.json();
            const list = data?.result?.place?.list;
            if (Array.isArray(list)) {
              for (const item of list) {
                apiItems.push({ placeId: String(item.id), placeName: item.name });
              }
            }
          } catch { /* 무시 */ }
        }
      });

      let searchUrl = `https://map.naver.com/p/search/${encodeURIComponent(keyword)}`;
      if (lng && lat) {
        searchUrl += `?c=${lng},${lat},15,0,0,0,dh`;
      }
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // searchIframe 대기
      let searchFrame = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        await page.waitForTimeout(400);
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
          } catch { /* 프레임 준비 안됨 */ }
        }
      }

      if (!searchFrame) {
        await context.close().catch(() => {});
        return [];
      }

      // Apollo placeId 맵
      const apolloIdMap = await buildApolloIdMap(searchFrame);

      // DOM 수집 루프
      const results = [];
      let organicCount = 0;
      let currentPage = 1;
      const MAX_PAGES = 5;
      const seenIds = new Set();
      const seenNames = new Set();

      while (organicCount < maxRank && currentPage <= MAX_PAGES) {
        await scrollToBottom(searchFrame);
        const domItems = await collectPcDomItems(searchFrame);

        // placeId 보충
        for (const item of domItems) {
          if (!item.placeId) {
            const apolloId = apolloIdMap.get(item.placeName);
            if (apolloId) {
              item.placeId = apolloId;
            } else {
              const apiMatch = apiItems.find(a => a.placeName === item.placeName);
              if (apiMatch) item.placeId = apiMatch.placeId;
            }
          }
        }

        for (const item of domItems) {
          if (organicCount >= maxRank) break;
          const idKey = item.placeId || null;
          const nameKey = item.placeName;
          if ((idKey && seenIds.has(idKey)) || seenNames.has(nameKey)) continue;
          if (idKey) seenIds.add(idKey);
          seenNames.add(nameKey);

          if (!item.isAd) {
            organicCount++;
            results.push({
              rank: organicCount,
              placeId: item.placeId || null,
              placeName: item.placeName,
            });
          }
        }

        if (organicCount >= maxRank) break;
        const hasNext = await clickNextPage(searchFrame, currentPage + 1);
        if (!hasNext) break;

        currentPage++;
        await page.waitForTimeout(2000);
        for (let i = 0; i < 10; i++) {
          await page.waitForTimeout(300);
          try {
            const firstDomName = await searchFrame.evaluate(() => {
              const first = document.querySelector('li.UEzoS span.TYaxT');
              return first?.textContent?.trim() || null;
            });
            if (firstDomName && !seenNames.has(firstDomName)) break;
          } catch { /* 대기 */ }
        }
      }

      await context.close().catch(() => {});
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
      console.error(`[crawl-pc] ${keyword} 실패:`, msg);
      return [];
    }
  }
  return [];
}

// ═══════════════════════════════════════════════════
// PC 지도 헬퍼 함수들
// ═══════════════════════════════════════════════════

async function scrollToBottom(frame) {
  let prevCount = 0;
  let stableCount = 0;
  for (let i = 0; i < 20; i++) {
    try {
      const count = await frame.evaluate(() => {
        const sc = document.querySelector('#_pcmap_list_scroll_container');
        if (sc) sc.scrollTop = sc.scrollHeight;
        return document.querySelectorAll('li.UEzoS').length;
      });
      if (count === prevCount) {
        stableCount++;
        if (stableCount >= 3) break;
      } else {
        stableCount = 0;
      }
      prevCount = count;
    } catch { break; }
    await new Promise(r => setTimeout(r, 600));
  }
}

async function buildApolloIdMap(frame) {
  try {
    const pairs = await frame.evaluate(() => {
      const apollo = window.__APOLLO_STATE__;
      if (!apollo) return [];
      const rq = apollo['ROOT_QUERY'];
      if (!rq) return [];
      const listKey = Object.keys(rq).find(
        k => k.includes('List') && !k.includes('Filter') && !k.includes('__typename') &&
             (k.includes('"display":70') || k.includes('"display":50'))
      );
      if (!listKey) return [];
      const listData = rq[listKey];
      if (!listData?.items) return [];
      return listData.items.map(entry => {
        const ref = entry?.__ref;
        if (!ref) return null;
        const item = apollo[ref];
        if (!item || !item.name || !item.id) return null;
        return [item.name, String(item.id)];
      }).filter(Boolean);
    });
    return new Map(pairs);
  } catch {
    return new Map();
  }
}

async function collectPcDomItems(frame) {
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
        (li.getAttribute('data-laim-exp-id') || '').includes('*e')
      );

      let placeId = null;
      try {
        const fiberKey = Object.keys(li).find(k =>
          k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        if (fiberKey) {
          let fiber = li[fiberKey];
          for (let depth = 0; depth < 15; depth++) {
            const props = fiber?.memoizedProps || fiber?.pendingProps;
            if (props) {
              const id = props.id || props.placeId || props.item?.id || props.data?.id;
              if (id && /^\d{5,}$/.test(String(id))) {
                placeId = String(id);
                break;
              }
            }
            fiber = fiber?.return;
            if (!fiber) break;
          }
        }
      } catch { /* 무시 */ }

      items.push({ placeName, isAd, placeId });
    }
    return items;
  });
}

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

// ═══════════════════════════════════════════════════
// 유틸리티 함수들
// ═══════════════════════════════════════════════════

/**
 * Place ID로 업체명을 가져온다.
 */
export async function fetchPlaceName(placeId) {
  const PLACE_TYPES = ['restaurant', 'cafe', 'place', 'hairshop', 'hospital', 'accommodation'];

  for (const type of PLACE_TYPES) {
    try {
      const res = await fetch(`https://pcmap.place.naver.com/${type}/${placeId}/home`, {
        headers: {
          'User-Agent': DEFAULT_UA,
          'Accept': 'text/html',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        },
      });
      if (!res.ok) continue;
      const html = await res.text();
      if (html.includes('찾을 수 없습니다')) continue;

      const ogMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
      if (ogMatch) {
        const name = ogMatch[1].split(':')[0]?.trim();
        if (name && !name.includes('네이버') && !name.includes('플레이스')) return name;
      }
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) {
        const name = titleMatch[1].split(':')[0]?.trim();
        if (name && !name.includes('네이버') && !name.includes('플레이스')) return name;
      }
    } catch { /* 다음 타입 시도 */ }
  }

  let context = null;
  try {
    const browser = await getBrowser(true);
    context = await browser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 1920, height: 1080 },
      locale: 'ko-KR',
    });
    const page = await createLightPage(context);
    await page.goto(`https://map.naver.com/p/entry/place/${placeId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    let name = null;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(500);
      const placeFrame = page.frames().find(f => f.url().includes('pcmap.place.naver.com'));
      if (placeFrame) {
        name = await placeFrame.evaluate(() => {
          const el = document.querySelector('span.GHAhO, h2.tit, .Fc1rA');
          if (el) return el.textContent?.trim() || null;
          const ogTitle = document.querySelector('meta[property="og:title"]');
          if (ogTitle) {
            const n = ogTitle.getAttribute('content')?.split(':')[0]?.trim();
            if (n && !n.includes('네이버') && !n.includes('플레이스')) return n;
          }
          return null;
        }).catch(() => null);
        if (name) break;
      }
    }

    await context.close().catch(() => {});
    return name;
  } catch {
    if (context) await context.close().catch(() => {});
    return null;
  }
}

/**
 * 업체명으로 좌표를 추출한다.
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
 * naver.me 단축 URL 리다이렉트 처리.
 */
export async function resolveRedirectUrl(shortUrl) {
  try {
    const res = await fetch(shortUrl, {
      headers: { 'User-Agent': DEFAULT_UA },
      redirect: 'follow',
    });
    if (res.url && res.url !== shortUrl) return res.url;
  } catch { /* 폴백 */ }

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
