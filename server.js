#!/usr/bin/env node

/**
 * 네이버 플레이스 순위 추적기 — 웹 대시보드 서버
 */
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { dirname, resolve, extname } from 'path';
import { fileURLToPath } from 'url';

import { crawlNaverPlace, fetchPlaceName } from './src/crawler.js';
import { extractPlaceId, parseRankFromResults } from './src/parser.js';
import { loadHistory, saveResult, getPreviousRank } from './src/history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ─── API 라우트 ───

  // GET /api/history
  if (path === '/api/history' && req.method === 'GET') {
    try {
      const history = await loadHistory();
      sendJson(res, 200, history);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /api/place-name?id=xxx
  if (path === '/api/place-name' && req.method === 'GET') {
    const placeId = url.searchParams.get('id');
    if (!placeId) {
      sendJson(res, 400, { error: 'id 파라미터 필요' });
      return;
    }
    try {
      const name = await fetchPlaceName(placeId);
      sendJson(res, 200, { placeId, name });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/check
  if (path === '/api/check' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { url: placeUrl, keywords, maxRank = 50 } = body;

      let placeId = extractPlaceId(placeUrl);
      if (!placeId && /^\d+$/.test(placeUrl)) placeId = placeUrl;

      if (!placeId) {
        sendJson(res, 400, { error: '유효한 Place URL 또는 ID를 입력해주세요.' });
        return;
      }

      // 업체명 조회
      let placeName = null;
      try {
        placeName = await fetchPlaceName(placeId);
      } catch { /* 무시 */ }

      const history = await loadHistory();
      const results = [];

      for (const keyword of keywords) {
        const crawlResults = await crawlNaverPlace(keyword, { maxRank });
        const rankResult = parseRankFromResults(crawlResults, placeId, placeName);
        const prevRank = getPreviousRank(history, placeId, keyword);

        await saveResult(
          placeId,
          rankResult.placeName || placeName || placeId,
          placeUrl,
          keyword,
          rankResult
        );

        results.push({
          keyword,
          found: rankResult.found,
          rank: rankResult.rank,
          previousRank: prevRank,
          placeName: rankResult.placeName || placeName,
          matchedBy: rankResult.matchedBy,
          totalResults: rankResult.totalResults,
        });
      }

      sendJson(res, 200, { placeId, placeName, results });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // ─── 정적 파일 서빙 ───
  let filePath = path === '/' ? '/index.html' : path;
  const fullPath = resolve(PUBLIC_DIR, filePath.slice(1));

  // 디렉토리 트래버설 방지
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(fullPath);
    const ext = extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  🌐 네이버 플레이스 순위 추적기 대시보드`);
  console.log(`  ➜ http://localhost:${PORT}\n`);
});
