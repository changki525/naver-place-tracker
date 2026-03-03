/**
 * 네이버 지도 검색 결과 크롤링
 *
 * 정확도 전략:
 * - DOM 순서 = 실제 화면 표시 순서 (정확한 순위)
 * - Apollo State = 누락된 DOM 항목 보충 + placeId 보충
 *
 * 속도 최적화:
 * - 이미지/폰트/미디어/광고 리소스 차단
 * - 스크롤 대기 시간 최소화
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
 * 리소스 차단이 적용된 경량 페이지 생성.
 */
async function createLightPage(context) {
  const page = await context.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,eot,otf,mp4,mp3,webm}', r => r.abort());
  await page.route('**/{analytics,adservice,doubleclick,googlesyndication,googletagmanager}**', r => r.abort());
  return page;
}

/**
 * 네이버 지도에서 키워드 검색 후 플레이스 결과 목록을 반환한다.
 *
 * 순위 정확도: DOM 순서(실제 화면) 기준 + Apollo 누락분 보충
 */
export async function crawlNaverPlace(keyword, options = {}) {
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

      // 네이버 지도 검색 페이지 접속
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

      // 현재 페이지 DOM + Apollo 수집
      const results = [];
      let organicCount = 0;
      let currentPage = 1;
      const MAX_PAGES = 5;
      const seenIds = new Set();
      const seenNames = new Set();

      while (organicCount < maxRank && currentPage <= MAX_PAGES) {
        // 스크롤하여 전체 DOM 로드
        await scrollToBottom(searchFrame);

        // DOM 수집 (실제 화면 순서 = 정확한 순위)
        const domItems = await collectDomItems(searchFrame);
        // Apollo 수집 (누락분 보충 + placeId)
        const apolloItems = await collectApolloItems(searchFrame);

        // DOM 기반 병합 (DOM 순서 유지, Apollo 누락분 삽입)
        const pageItems = mergeDomFirst(domItems, apolloItems);

        // 광고는 maxRank 카운트에서 제외, 중복도 제거
        for (const item of pageItems) {
          if (organicCount >= maxRank) break;

          // 중복 체크 (placeId 또는 이름 기준)
          const idKey = item.placeId || null;
          const nameKey = item.placeName;
          if ((idKey && seenIds.has(idKey)) || seenNames.has(nameKey)) continue;
          if (idKey) seenIds.add(idKey);
          seenNames.add(nameKey);

          results.push({
            rank: results.length + 1,
            placeId: item.placeId || null,
            placeName: item.placeName,
            isAd: item.isAd,
          });
          if (!item.isAd) organicCount++;
        }

        if (organicCount >= maxRank) break;

        const hasNext = await clickNextPage(searchFrame, currentPage + 1);
        if (!hasNext) break;

        currentPage++;
        await page.waitForTimeout(2500);
      }

      await context.close().catch(() => {});

      const organicResults = results.filter(r => !r.isAd);
      console.log(`[crawl] ${keyword}: ${organicResults.length}건 수집`);
      return organicResults.map((r, i) => ({
        rank: i + 1,
        placeId: r.placeId,
        placeName: r.placeName,
      }));
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
 * 스크롤하여 전체 DOM 항목 로드.
 * 리소스 차단 덕에 빠르게 완료됨.
 */
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
    } catch {
      break;
    }
    await new Promise(r => setTimeout(r, 600));
  }
}

/**
 * DOM에서 업체 목록을 수집한다.
 * 순서 = 실제 화면 표시 순서 (정확한 순위).
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

      // 광고 판별
      const isAd = !!(
        li.querySelector('.cZnHG') ||
        li.querySelector('[class*="icon_ad"]') ||
        li.getAttribute('data-laim-exp-id')?.includes('*e')
      );

      // React Fiber에서 placeId 추출
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

      // 모든 카테고리 지원: restaurantList, cafeList, placeList, beautyList 등
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
 * DOM 순서를 기준으로 결과를 병합한다.
 *
 * DOM 순서 = 실제 화면 표시 순서 (정확한 순위).
 * Apollo에만 있는 항목은 Apollo 내 이웃 기준으로 올바른 위치에 삽입.
 */
function mergeDomFirst(domItems, apolloItems) {
  if (apolloItems.length === 0) return domItems;

  const domAds = domItems.filter(d => d.isAd);
  const domOrganic = domItems.filter(d => !d.isAd);

  // DOM 항목에 Apollo placeId 보충
  const enriched = domOrganic.map(d => {
    if (d.placeId) return d;
    // placeId가 없으면 Apollo에서 이름 매칭으로 보충
    const aMatch = apolloItems.find(a => a.placeName === d.placeName);
    return aMatch ? { ...d, placeId: aMatch.placeId } : d;
  });

  // DOM에 없는 Apollo 항목 찾기
  const domNameSet = new Set(domOrganic.map(d => d.placeName));
  const domIdSet = new Set(domOrganic.filter(d => d.placeId).map(d => d.placeId));

  const apolloOnly = apolloItems.filter(a =>
    !domNameSet.has(a.placeName) &&
    !(a.placeId && domIdSet.has(a.placeId))
  );

  if (apolloOnly.length === 0) return [...domAds, ...enriched];

  // Apollo 순서에서 이웃을 찾아 올바른 위치에 삽입
  const result = [...enriched];

  for (const missing of apolloOnly) {
    const apolloIdx = apolloItems.findIndex(a =>
      (a.placeId && a.placeId === missing.placeId) ||
      a.placeName === missing.placeName
    );

    // 이전 Apollo 이웃 중 DOM에 있는 항목 찾기
    let insertAfterIdx = -1;
    for (let i = apolloIdx - 1; i >= 0; i--) {
      const neighbor = apolloItems[i];
      const domIdx = result.findIndex(d =>
        (d.placeId && neighbor.placeId && d.placeId === neighbor.placeId) ||
        d.placeName === neighbor.placeName
      );
      if (domIdx !== -1) {
        insertAfterIdx = domIdx;
        break;
      }
    }

    // 삽입
    result.splice(insertAfterIdx + 1, 0, {
      placeName: missing.placeName,
      placeId: missing.placeId,
      isAd: false,
    });
  }

  return [...domAds, ...result];
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
 * 여러 카테고리 타입을 시도하고, 실패 시 Playwright 폴백.
 */
export async function fetchPlaceName(placeId) {
  const PLACE_TYPES = ['restaurant', 'cafe', 'place', 'hairshop', 'hospital', 'accommodation'];

  // 1차: HTTP — 여러 카테고리 타입 시도
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

  // 2차: Playwright — map entry URL 사용 (카테고리 자동 감지)
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

    // place iframe 대기 후 이름 추출
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
