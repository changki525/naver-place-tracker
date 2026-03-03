#!/usr/bin/env node

/**
 * 네이버 플레이스 순위 추적기 CLI
 *
 * 사용법:
 *   node index.js check -u <placeUrl> -k <keyword> [-k <keyword2>]
 *   node index.js history -u <placeUrl> [-k <keyword>]
 *   node index.js run -c <config.json>
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

import { crawlNaverPlace, resolveRedirectUrl, fetchPlaceName } from './src/crawler.js';
import { extractPlaceId, parseRankFromResults } from './src/parser.js';
import { loadHistory, saveResult, getPreviousRank, getPlaceHistory } from './src/history.js';
import { displayResult, displayHistory, displayBatchResults } from './src/display.js';

const program = new Command();

program
  .name('naver-place')
  .description('네이버 플레이스(지도) 검색 순위 추적 도구')
  .version('1.0.0');

// ─── check 커맨드 ───
program
  .command('check')
  .description('특정 업체의 현재 검색 순위를 확인합니다')
  .requiredOption('-u, --url <placeUrl>', '네이버 플레이스 URL (또는 Place ID)')
  .requiredOption('-k, --keyword <keywords...>', '검색 키워드 (여러 개 가능)')
  .option('-m, --max-rank <number>', '최대 탐색 순위', '50')
  .option('-n, --name <placeName>', '업체명 (이름 기반 매칭용)')
  .option('--no-headless', '브라우저 창 표시 (디버깅용)')
  .action(async (opts) => {
    try {
      let placeId = extractPlaceId(opts.url);
      let placeUrl = opts.url;

      // naver.me 단축 URL 처리
      if (!placeId && opts.url.includes('naver.me')) {
        console.log(chalk.gray('  단축 URL 리다이렉트 추적 중...'));
        const resolved = await resolveRedirectUrl(opts.url);
        placeId = extractPlaceId(resolved);
        placeUrl = resolved;
        if (!placeId) {
          console.log(chalk.red('  오류: 리다이렉트 URL에서 Place ID를 추출할 수 없습니다.'));
          console.log(chalk.gray(`  리다이렉트 URL: ${resolved}`));
          process.exit(1);
        }
      }

      // 숫자만 입력한 경우 ID로 간주
      if (!placeId && /^\d+$/.test(opts.url)) {
        placeId = opts.url;
        placeUrl = `https://map.naver.com/v5/entry/place/${placeId}`;
      }

      if (!placeId) {
        console.log(chalk.red('  오류: 유효한 네이버 플레이스 URL을 입력해주세요.'));
        console.log(chalk.gray('  예: https://map.naver.com/v5/entry/place/123456789'));
        process.exit(1);
      }

      // 업체명 자동 조회 (--name 미지정 시)
      let placeName = opts.name || null;
      if (!placeName) {
        console.log(chalk.gray('  업체명 조회 중...'));
        placeName = await fetchPlaceName(placeId);
        if (placeName) {
          console.log(chalk.gray(`  업체명: ${placeName}`));
        }
      }

      console.log(chalk.bold.white(`\n  네이버 플레이스 순위 조회`));
      console.log(chalk.gray(`  Place ID: ${placeId}`));
      if (placeName) console.log(chalk.gray(`  업체명: ${placeName}`));

      const history = await loadHistory();
      const maxRank = parseInt(opts.maxRank, 10);

      for (const keyword of opts.keyword) {
        console.log(chalk.gray(`\n  "${keyword}" 검색 중...`));

        const results = await crawlNaverPlace(keyword, {
          maxRank,
          headless: opts.headless,
        });

        if (results.length === 0) {
          console.log(chalk.yellow('  검색 결과가 없습니다.'));
          continue;
        }

        console.log(chalk.gray(`  ${results.length}개 결과 수집 완료`));

        const rankResult = parseRankFromResults(results, placeId, placeName);
        const prevRank = getPreviousRank(history, placeId, keyword);

        // 결과 저장
        await saveResult(
          placeId,
          rankResult.placeName || placeName || placeId,
          placeUrl,
          keyword,
          rankResult
        );

        // 출력
        displayResult(keyword, rankResult, prevRank);

        // 키워드 간 딜레이 (마지막이 아니면)
        if (opts.keyword.indexOf(keyword) < opts.keyword.length - 1) {
          await sleep(3000);
        }
      }
    } catch (err) {
      console.error(chalk.red(`\n  오류: ${err.message}`));
      process.exit(1);
    }
  });

// ─── history 커맨드 ───
program
  .command('history')
  .description('업체의 순위 변동 이력을 조회합니다')
  .requiredOption('-u, --url <placeUrl>', '네이버 플레이스 URL (또는 Place ID)')
  .option('-k, --keyword <keyword>', '특정 키워드로 필터링')
  .action(async (opts) => {
    try {
      let placeId = extractPlaceId(opts.url);
      if (!placeId && /^\d+$/.test(opts.url)) {
        placeId = opts.url;
      }
      if (!placeId) {
        console.log(chalk.red('  오류: 유효한 Place ID 또는 URL을 입력해주세요.'));
        process.exit(1);
      }

      const history = await loadHistory();
      const placeInfo = history.places?.[placeId];

      if (!placeInfo) {
        console.log(chalk.yellow(`\n  Place ID ${placeId}에 대한 기록이 없습니다.`));
        console.log(chalk.gray('  먼저 "check" 명령으로 순위를 조회해주세요.'));
        return;
      }

      const data = getPlaceHistory(history, placeId, opts.keyword || null);
      displayHistory(placeInfo, data);
    } catch (err) {
      console.error(chalk.red(`\n  오류: ${err.message}`));
      process.exit(1);
    }
  });

// ─── run 커맨드 ───
program
  .command('run')
  .description('설정 파일 기반으로 여러 업체/키워드를 일괄 조회합니다')
  .requiredOption('-c, --config <path>', 'JSON 설정 파일 경로')
  .action(async (opts) => {
    try {
      const configPath = resolve(opts.config);
      const raw = await readFile(configPath, 'utf-8');
      const config = JSON.parse(raw);

      if (!Array.isArray(config) && !config.places) {
        // 배열 형태 또는 { places: [...] } 형태 모두 지원
        console.log(chalk.red('  오류: 설정 파일 형식이 올바르지 않습니다.'));
        process.exit(1);
      }

      const places = Array.isArray(config) ? config : config.places;
      const globalOpts = config.options || {};
      const maxRank = globalOpts.maxRank || 50;
      const delayMs = globalOpts.delayMs || 3000;

      console.log(chalk.bold.white(`\n  배치 실행: ${places.length}개 업체`));

      const history = await loadHistory();
      const batchResults = [];

      for (const place of places) {
        let placeId = extractPlaceId(place.placeUrl || place.url);
        if (!placeId && /^\d+$/.test(place.placeUrl || place.url || '')) {
          placeId = place.placeUrl || place.url;
        }

        if (!placeId) {
          console.log(chalk.yellow(`  "${place.name}": Place ID를 추출할 수 없어 건너뜁니다.`));
          continue;
        }

        for (const keyword of place.keywords) {
          console.log(chalk.gray(`  ${place.name} - "${keyword}" 검색 중...`));

          const results = await crawlNaverPlace(keyword, { maxRank });
          const rankResult = parseRankFromResults(results, placeId, place.name);
          const prevRank = getPreviousRank(history, placeId, keyword);

          await saveResult(
            placeId,
            rankResult.placeName || place.name,
            place.placeUrl || place.url,
            keyword,
            rankResult
          );

          batchResults.push({
            placeName: rankResult.placeName || place.name,
            keyword,
            rank: rankResult.rank,
            previousRank: prevRank,
            found: rankResult.found,
          });

          await sleep(delayMs);
        }
      }

      displayBatchResults(batchResults);
    } catch (err) {
      console.error(chalk.red(`\n  오류: ${err.message}`));
      process.exit(1);
    }
  });

program.parse();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
