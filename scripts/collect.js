// データ収集スクリプト（GitHub Actions で定期実行し、GitHub Pages に公開する）
//   node scripts/collect.js <出力フォルダ>
// 出力: <出力フォルダ>/market.json（タイル用）, charts.json（大きいチャートの1日・5日用）
// ウォッチリストはリポジトリの watchlist.json（[{ "symbol": "7203.T" }, ...]）
import fs from "node:fs";
import path from "node:path";
import * as core from "../src/core.js";

const OUT = process.argv[2] || "_site/data";
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.json";

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

const started = Date.now();
let watchlist = [];
try {
  watchlist = JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8"));
  if (!Array.isArray(watchlist)) throw new Error("配列ではありません");
  watchlist = watchlist.filter((w) => w && typeof w.symbol === "string").map((w) => ({ symbol: w.symbol.trim(), name: w.name }));
} catch (e) {
  console.log(`watchlist.json を読み込めませんでした（${e.message}）。ウォッチリストなしで続行します`);
  watchlist = [];
}
const items = core.makeItems(watchlist);
const ctx = { left: Infinity };
const log = [];

// 1) 日足（1年分）と日本10年債
const store = { daily: {} };
await core.refreshDaily(ctx, store, items, { log });

// 2) タイル用データ（最新値・前日比・当日の値動き・VIX先物・大阪先物）
const market = await core.market(ctx, store, items);

// 3) 大きいチャートの「1日」「5日」用（ローソク足用の始値・高値・安値つき）
const charts = {};
await mapLimit(items.filter((s) => !s.source), 2, async (s) => {
  charts[s.key] = {};
  for (const r of ["1d", "5d"]) {
    try { charts[s.key][r] = await core.chart(ctx, store, s, r); }
    catch (e) { log.push(`${s.symbol} ${r}: ${e.message}`); }
  }
});

const errors = market.quotes.filter((q) => q.error);
console.log(`銘柄 ${market.quotes.length} / エラー ${errors.length} / 日足 ${Object.keys(store.daily).length} / ${((Date.now() - started) / 1000).toFixed(1)}秒`);
for (const q of errors) console.log(`  ${q.name}: ${q.error}`);
for (const l of log.slice(0, 20)) console.log(`  ${l}`);

// ほとんど取れなかった場合は失敗扱いにして、公開中の前回データを残す
if (errors.length > market.quotes.length / 2) {
  console.error("エラーが多すぎるため公開を中止しました");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "market.json"), JSON.stringify(market));
fs.writeFileSync(path.join(OUT, "charts.json"), JSON.stringify(charts));
console.log(`${OUT} に出力しました`);
