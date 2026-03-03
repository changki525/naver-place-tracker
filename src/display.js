/**
 * 터미널 출력 포맷팅
 */
import chalk from 'chalk';

/**
 * 개별 순위 결과를 출력한다.
 */
export function displayResult(keyword, rankResult, previousRank) {
  const line = '\u2501'.repeat(40);

  console.log('');
  console.log(chalk.cyan(`  \u{1F50D} \uAC80\uC0C9 \uD0A4\uC6CC\uB4DC: ${chalk.bold.yellow(keyword)}`));
  if (rankResult.placeName) {
    console.log(chalk.cyan(`  \u{1F4CD} \uC5C5\uCCB4\uBA85: ${chalk.bold.white(rankResult.placeName)}`));
  }
  console.log(chalk.gray(`  ${line}`));

  if (!rankResult.found) {
    console.log(chalk.red('    \uD604\uC7AC \uC21C\uC704:   \uC21C\uC704\uAD8C \uBC16 (\uAC80\uC0C9 \uACB0\uACFC\uC5D0\uC11C \uCC3E\uC744 \uC218 \uC5C6\uC74C)'));
    console.log(chalk.gray(`    \uD0D0\uC0C9 \uBC94\uC704:   ${rankResult.totalResults}\uAC1C`));
    console.log(chalk.gray(`    \uC870\uD68C \uC2DC\uAC01:  ${formatTime()}`));
    console.log(chalk.gray(`  ${line}`));
    return;
  }

  const rank = rankResult.rank;
  const rankColor = rank <= 3 ? chalk.bold.green : rank <= 10 ? chalk.bold.yellow : chalk.bold.white;

  console.log(`    \uD604\uC7AC \uC21C\uC704:   ${rankColor(`${rank}\uC704`)}`);

  if (previousRank !== null) {
    console.log(`    \uC774\uC804 \uC21C\uC704:  ${previousRank}\uC704`);
    const diff = previousRank - rank;
    if (diff > 0) {
      console.log(`    \uBCC0\uB3D9:       ${chalk.green(`\u25B2 ${diff} (\uC0C1\uC2B9)`)}`);
    } else if (diff < 0) {
      console.log(`    \uBCC0\uB3D9:       ${chalk.red(`\u25BC ${Math.abs(diff)} (\uD558\uB77D)`)}`);
    } else {
      console.log(`    \uBCC0\uB3D9:       ${chalk.gray('\u2014 (\uBCC0\uB3D9 \uC5C6\uC74C)')}`);
    }
  } else {
    console.log(`    \uBCC0\uB3D9:       ${chalk.gray('\u2014 (\uCCAB \uC870\uD68C)')}`);
  }

  console.log(chalk.gray(`    \uC870\uD68C \uC2DC\uAC01:  ${formatTime()}`));
  console.log(chalk.gray(`  ${line}`));
}

/**
 * 이력을 테이블 형태로 출력한다.
 */
export function displayHistory(placeInfo, historyData) {
  const line = '\u2550'.repeat(55);

  console.log('');
  console.log(chalk.cyan(`  ${line}`));
  console.log(chalk.bold.white(`  \u{1F4CA} ${placeInfo.placeName || placeInfo.placeId} \uC21C\uC704 \uC774\uB825`));
  console.log(chalk.cyan(`  ${line}`));

  if (!historyData || historyData.length === 0) {
    console.log(chalk.gray('    \uAE30\uB85D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.'));
    console.log(chalk.cyan(`  ${line}`));
    return;
  }

  // 키워드 요약 형태
  if (historyData[0]?.keyword) {
    console.log(chalk.gray('    \uD0A4\uC6CC\uB4DC              \uCD5C\uC2E0\uC21C\uC704  \uBCC0\uB3D9    \uD68C\uC218'));
    console.log(chalk.gray('    ' + '\u2500'.repeat(48)));

    for (const entry of historyData) {
      const kw = entry.keyword.padEnd(16);
      const rankStr = entry.latestRank !== null ? `${entry.latestRank}\uC704`.padEnd(8) : '\uC21C\uC704\uAD8C\uBC16'.padEnd(8);
      const changeStr = getChangeStr(entry.latestRank, entry.previousRank).padEnd(10);
      const count = `${entry.recordCount}\uD68C`;
      console.log(`    ${kw} ${rankStr} ${changeStr} ${count}`);
    }
  } else {
    // 특정 키워드의 상세 기록
    console.log(chalk.gray('    \uB0A0\uC9DC                  \uC21C\uC704    \uBCC0\uB3D9'));
    console.log(chalk.gray('    ' + '\u2500'.repeat(48)));

    let prev = null;
    for (let i = historyData.length - 1; i >= 0; i--) {
      const r = historyData[i];
      const time = new Date(r.timestamp).toLocaleString('ko-KR');
      const rankStr = r.rank !== null ? `${r.rank}\uC704`.padEnd(8) : '\uC21C\uC704\uAD8C\uBC16'.padEnd(8);
      const changeStr = prev !== null ? getChangeStr(r.rank, prev).padEnd(10) : '\u2014'.padEnd(10);
      console.log(`    ${time.padEnd(22)} ${rankStr} ${changeStr}`);
      prev = r.rank;
    }
  }

  console.log(chalk.cyan(`  ${line}`));
}

/**
 * 배치 결과를 요약 출력한다.
 */
export function displayBatchResults(results) {
  const line = '\u2550'.repeat(55);

  console.log('');
  console.log(chalk.magenta(`  ${line}`));
  console.log(chalk.bold.white('  \u{1F4CB} \uBC30\uCE58 \uC2E4\uD589 \uACB0\uACFC'));
  console.log(chalk.magenta(`  ${line}`));

  for (const r of results) {
    const name = (r.placeName || '').padEnd(14);
    const kw = r.keyword.padEnd(16);
    const rankStr = r.rank !== null ? chalk.yellow(`${r.rank}\uC704`) : chalk.gray('\uC21C\uC704\uAD8C\uBC16');
    const changeStr = getChangeStr(r.rank, r.previousRank);
    console.log(`    ${name} ${kw} ${rankStr.padEnd(16)} ${changeStr}`);
  }

  console.log(chalk.magenta(`  ${line}`));
  console.log('');
}

function getChangeStr(current, previous) {
  if (current === null || previous === null) return chalk.gray('\u2014');
  const diff = previous - current;
  if (diff > 0) return chalk.green(`\u25B2${diff}`);
  if (diff < 0) return chalk.red(`\u25BC${Math.abs(diff)}`);
  return chalk.gray('\u2014');
}

function formatTime() {
  return new Date().toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
