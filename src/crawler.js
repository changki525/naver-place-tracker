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
  // 기존 브라우저가 연결 해제되었으면 정리
  if (_browser && !_browser.isConnected()) {
    _browser = null;
  }
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
 * 네이버 지도에서 키워드 검색 후 플레이스 결과 목록을 반환한다.
 * 브라우저 크래시 시 1회 자동 재시도.
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
      const page = await context.newPage();

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

      // 네이버 지도 검색 페이지 접속 (좌표 포함 시 해당 위치 기준 검색)
      let searchUrl = `https://map.naver.com/p/search/${encodeURIComponent(keyword)}`;
      if (lng && lat) {
        searchUrl += `?c=${lng},${lat},15,0,0,0,dh`;
      }
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

      if (!searchFrame) {
        await context.close().catch(() => {});
        return [];
      }

      // iframe 초기 로딩 안정화 대기
      await page.waitForTimeout(2000);

      // 현재 페이지 DOM에서 결과 수집 (최대 5페이지)
      const results = [];
      let currentPage = 1;
      const MAX_PAGES = 5;

      while (results.length < maxRank && currentPage <= MAX_PAGES) {
        await scrollToBottom(searchFrame);

        // Apollo State에서 전체 리스트 추출 (DOM 누락 보완용)
        const apolloItems = await collectApolloItems(searchFrame);
        const domItems = await collectDomItems(searchFrame);

        // DOM 아이템을 기본으로, Apollo 아이템으로 누락분 보충
        const pageItems = mergeResults(domItems, apolloItems);

        for (const item of pageItems) {
          if (results.length >= maxRank) break;

          // placeId: DOM(React Fiber)/Apollo → API 매칭 순으로 시도
          let placeId = item.placeId || null;
          if (!placeId && apiResults.length > 0) {
            const apiMatch = apiResults.find(
              a => a.placeName === item.placeName
            );
            if (apiMatch) placeId = apiMatch.placeId;
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
        // 페이지 전환 후 충분히 대기 (DOM 리로드)
        await page.waitForTimeout(3000);
      }

      await context.close().catch(() => {});

      const organicResults = results.filter(r => !r.isAd);
      return organicResults.map((r, i) => ({
        rank: i + 1,
        placeId: r.placeId,
        placeName: r.placeName,
      }));
    } catch (err) {
      // 컨텍스트 정리
      if (context) await context.close().catch(() => {});
      // 브라우저 크래시 → 싱글턴 완전 종료 후 재시도
      const msg = err.message || '';
      if (msg.includes('closed') || msg.includes('crashed') || msg.includes('disconnected')) {
        if (_browser) {
          await _browser.close().catch(() => {});
          _browser = null;
        }
        if (retry === 0) {
          // 재시도 전 잠시 대기 (브라우저 리소스 해제)
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      }
      // 재시도 실패 시에도 throw 대신 빈 배열 반환 (다음 키워드 진행 가능)
      console.error(`[crawl] ${keyword} 실패 (retry=${retry}):`, msg);
      return [];
    }
  }
  return [];
}

/**
 * searchIframe을 맨 아래까지 스크롤한다.
 * 바닥으로 점프 후 아이템 수 안정화 대기.
 */
async function scrollToBottom(frame) {
  let prevCount = 0;
  let sameCount = 0;

  for (let attempts = 0; attempts < 20; attempts++) {
    const info = await frame.evaluate(() => {
      const sc = document.querySelector('#_pcmap_list_scroll_container');
      if (!sc) return { scrolled: false, count: 0 };
      sc.scrollTop = sc.scrollHeight;
      return {
        scrolled: true,
        count: document.querySelectorAll('li.UEzoS').length,
      };
    });

    if (!info.scrolled) break;

    await new Promise(r => setTimeout(r, 1200));

    if (info.count === prevCount) {
      sameCount++;
      if (sameCount >= 3) break;
    } else {
      sameCount = 0;
    }
    prevCount = info.count;
  }
}

/**
 * searchIframe의 Apollo State(window.__APOLLO_STATE__)에서
 * 검색 결과 리스트를 추출한다.
 * DOM에 렌더링되지 않는 결과도 포함되어 더 완전한 목록을 제공.
 */
async function collectApolloItems(frame) {
  try {
    return await frame.evaluate(() => {
      const apollo = window.__APOLLO_STATE__;
      if (!apollo) return [];

      const rq = apollo['ROOT_QUERY'];
      if (!rq) return [];

      // display가 가장 큰 메인 리스트 키 찾기 (Filter 제외)
      const listKey = Object.keys(rq).find(
        k => k.includes('restaurantList') && !k.includes('Filter') &&
             (k.includes('"display":70') || k.includes('"display":50'))
      );
      if (!listKey) return [];

      const listData = rq[listKey];
      if (!listData?.items) return [];

      const items = [];
      for (const entry of listData.items) {
        const ref = entry?.__ref;
        if (!ref) continue;
        const item = apollo[ref];
        if (!item || !item.name) continue;

        items.push({
          placeName: item.name,
          placeId: item.id ? String(item.id) : null,
          isAd: false, // Apollo 메인 리스트는 광고가 아닌 오가닉 결과
        });
      }

      return items;
    });
  } catch {
    return [];
  }
}

/**
 * DOM 결과와 Apollo 결과를 병합한다.
 * Apollo의 순서를 기준으로 하되, DOM에서 감지한 광고 정보를 반영.
 * DOM에만 있는 결과(광고 등)도 포함.
 */
function mergeResults(domItems, apolloItems) {
  if (apolloItems.length === 0) return domItems;

  // Apollo 기반의 결과를 기본으로 사용
  const merged = [];
  const usedDomIndices = new Set();

  // DOM의 광고 아이템 먼저 추출 (순서 유지)
  const domAds = domItems.filter(d => d.isAd);
  const domOrganic = domItems.filter(d => !d.isAd);

  // Apollo 리스트를 순서대로 추가
  for (const aItem of apolloItems) {
    // DOM에서 같은 업체 찾기 (placeId 또는 이름 매칭)
    const domIdx = domOrganic.findIndex((d, i) =>
      !usedDomIndices.has(i) &&
      ((d.placeId && d.placeId === aItem.placeId) ||
       d.placeName === aItem.placeName)
    );

    if (domIdx !== -1) {
      usedDomIndices.add(domIdx);
      // DOM의 데이터 우선 (Fiber placeId가 더 정확할 수 있음)
      merged.push({
        placeName: domOrganic[domIdx].placeName,
        placeId: domOrganic[domIdx].placeId || aItem.placeId,
        isAd: false,
      });
    } else {
      // Apollo에만 있는 결과 (DOM에서 누락된 항목)
      merged.push({
        placeName: aItem.placeName,
        placeId: aItem.placeId,
        isAd: false,
      });
    }
  }

  // DOM에만 있고 Apollo에 없는 오가닉 결과 추가
  for (let i = 0; i < domOrganic.length; i++) {
    if (!usedDomIndices.has(i)) {
      merged.push(domOrganic[i]);
    }
  }

  // 광고는 맨 앞에 추가 (isAd = true로 표시, 나중에 필터링됨)
  return [...domAds, ...merged];
}

/**
 * 현재 searchIframe DOM에서 업체 목록을 수집한다.
 * React Fiber에서 placeId를 추출하여 모든 페이지에서 정확한 매칭 지원.
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
        const fiberKey = Object.keys(li).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (fiberKey) {
          let fiber = li[fiberKey];
          for (let depth = 0; depth < 15; depth++) {
            const props = fiber?.memoizedProps || fiber?.pendingProps;
            if (props) {
              const id = props.id || props.placeId || props.item?.id || props.data?.id;
              if (id && /^\d{5,}$/.test(String(id))) { placeId = String(id); break; }
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
 * 브라우저 크래시 시 1회 자동 재시도.
 */
export async function fetchPlaceName(placeId) {
  for (let retry = 0; retry < 2; retry++) {
    let context = null;
    try {
      const browser = await getBrowser(true);
      context = await browser.newContext({
        userAgent: DEFAULT_UA,
        viewport: { width: 1920, height: 1080 },
        locale: 'ko-KR',
      });
      const page = await context.newPage();

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

      await context.close().catch(() => {});
      return name;
    } catch (err) {
      if (context) await context.close().catch(() => {});
      const msg = err.message || '';
      if ((msg.includes('closed') || msg.includes('crashed') || msg.includes('disconnected')) && retry === 0) {
        _browser = null;
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * 업체명으로 네이버 지도 검색 → allSearch API에서 해당 placeId의 좌표(x,y)를 추출한다.
 * 브라우저 크래시 시 1회 자동 재시도.
 *
 * @param {string} placeId - 대상 업체 Place ID
 * @param {string} placeName - 대상 업체명 (검색 쿼리로 사용)
 * @returns {{lng: string|null, lat: string|null}}
 */
export async function fetchPlaceCoords(placeId, placeName) {
  if (!placeName) return { lng: null, lat: null };

  for (let retry = 0; retry < 2; retry++) {
    let context = null;
    try {
      const browser = await getBrowser(true);
      context = await browser.newContext({
        userAgent: DEFAULT_UA,
        viewport: { width: 1920, height: 1080 },
        locale: 'ko-KR',
      });
      const page = await context.newPage();

      // allSearch API 응답에서 좌표 인터셉트
      let foundCoords = null;
      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('api/search/allSearch')) {
          try {
            const data = await response.json();
            const list = data?.result?.place?.list;
            if (Array.isArray(list)) {
              // placeId로 정확히 매칭
              const match = list.find(item => String(item.id) === String(placeId));
              if (match && match.x && match.y) {
                foundCoords = { lng: String(match.x), lat: String(match.y) };
              }
              // 매칭 실패 시 첫 번째 결과 좌표라도 사용 (같은 지역)
              if (!foundCoords && list.length > 0 && list[0].x && list[0].y) {
                foundCoords = { lng: String(list[0].x), lat: String(list[0].y) };
              }
            }
          } catch { /* 무시 */ }
        }
      });

      // 업체명으로 네이버 지도 검색
      const searchUrl = `https://map.naver.com/p/search/${encodeURIComponent(placeName)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      await context.close().catch(() => {});
      return foundCoords || { lng: null, lat: null };
    } catch (err) {
      if (context) await context.close().catch(() => {});
      const msg = err.message || '';
      if ((msg.includes('closed') || msg.includes('crashed') || msg.includes('disconnected')) && retry === 0) {
        _browser = null;
        continue;
      }
      return { lng: null, lat: null };
    }
  }
  return { lng: null, lat: null };
}

/**
 * naver.me 단축 URL을 리다이렉트 추적하여 실제 URL로 변환한다.
 */
export async function resolveRedirectUrl(shortUrl) {
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
