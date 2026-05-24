const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainJsPath = path.join(__dirname, '..', 'main.js');
const mainJsSource = fs.readFileSync(mainJsPath, 'utf8');

assert.match(mainJsSource, /@grant\s+unsafeWindow/);
assert.match(mainJsSource, /const pageWindow = typeof unsafeWindow !== 'undefined' \? unsafeWindow : window;/);
assert.match(mainJsSource, /function autoHighestLiveQualityLikeDD1969\b/);
assert.match(mainJsSource, /function maximizerAndRefreshLogic\b/);
assert.match(mainJsSource, /function getPlayerInfoSafely\b/);
assert.match(mainJsSource, /const QUALITY_SWITCH_COOLDOWN_MS = 3000;/);
assert.match(mainJsSource, /let lastQualitySwitchAt = 0;/);
assert.match(mainJsSource, /await new Promise\(resolve =>/);
assert.match(mainJsSource, /const initialPathname = new URL\(initialPlayerInfo\.playurl\)\.pathname/);
assert.match(mainJsSource, /const highestQualityNumber = initialPlayerInfo\.qualityCandidates\[0\]\.qn/);
assert.match(mainJsSource, /currentPathname === initialPathname/);
assert.match(mainJsSource, /pageWindow\.livePlayer\.switchQuality\(highestQualityNumber\)/);
assert.match(mainJsSource, /try \{[\s\S]*pageWindow\.livePlayer\.switchQuality\(highestQualityNumber\);[\s\S]*\} catch \(error\)/);
assert.match(mainJsSource, /skippedByCooldown/);
assert.match(mainJsSource, /lastSwitchAt/);
assert.match(mainJsSource, /setInterval\(\(\) => \{/);

assert.match(mainJsSource, /function checkLive\b/);
assert.match(mainJsSource, /function tryFullscreen\b/);
assert.match(mainJsSource, /function refreshPlayer\b/);

assert.doesNotMatch(
    mainJsSource,
    /\.hide-aside-area #player-ctnr video,[\s\S]*?z-index: 2147483647 !important;/
);
assert.doesNotMatch(mainJsSource, /bilibili-live-quality-status/);
assert.doesNotMatch(mainJsSource, /selectLiveQualityByDom/);
assert.doesNotMatch(mainJsSource, /dispatchUserLikeClick/);
assert.doesNotMatch(mainJsSource, /__biliLiveQualityInspect/);
assert.doesNotMatch(mainJsSource, /quality-wrap/);
assert.doesNotMatch(mainJsSource, /switchQualityAsync/);
assert.doesNotMatch(mainJsSource, /startLiveQualityGuard/);
assert.doesNotMatch(mainJsSource, /stopLiveQualityGuard/);
assert.doesNotMatch(mainJsSource, /ensureLiveQualityGuard/);

console.log('main.js checks passed');
