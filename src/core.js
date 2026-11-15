// マーケットデータ取得の共通ロジック（ローカルの Node サーバーと Cloudflare Workers の両方で使う）
//
// データの持ち方:
//   store = {
//     daily: { [symbol]: { at, rows: [[時刻, 終値, 始値, 高値, 安値], ...] } },  // 日足（重いので保存しておく）
//     mof:   { at, rows: [[時刻, 利回り], ...] },                               // 日本10年債
//   }
//   日中の値動き・VIX先物・大阪先物は、ページを開いたときにその場で取得する。
//
// ctx = { left: n } は外部への問い合わせ回数の上限（Workers 無料プランは1回の処理で50回まで）。

// group: 画面上のセクション / invert: 上昇が「悪い」指標（VIXなど）
// source: yahoo（既定） / mof（財務省 国債金利CSV） / cboe_vx（CBOE VIX先物） / tv（TradingView スキャナー）
export const SYMBOLS = [
  { key: "n225", symbol: "^N225", name: "日経平均", group: "jp" },
  { key: "topix", symbol: "1306.T", name: "TOPIX（ETF 1306）", group: "jp",
    note: "TOPIX指数はYahooで取得不可のため連動ETFで代用（騰落率はほぼ一致）" },
  { key: "nk_fut", symbol: "NIY=F", name: "日経225先物 CME", group: "jp" },
  { key: "nk_ose", source: "tv", tv: "OSE:NK225M1!", name: "日経225mini 大阪(CFD代替)", group: "jp", noChart: true,
    note: "日経CFDは無料の取得元がないため、ほぼ連動する大阪取引所の日経225mini先物（期近・夜間含む・15分遅れ）を表示" },

  { key: "dji", symbol: "^DJI", name: "NYダウ", group: "us" },
  { key: "spx", symbol: "^GSPC", name: "S&P 500", group: "us" },
  { key: "ndx", symbol: "^IXIC", name: "NASDAQ総合", group: "us" },
  { key: "sox", symbol: "^SOX", name: "SOX 半導体", group: "us" },
  { key: "rut", symbol: "^RUT", name: "ラッセル2000", group: "us" },
  { key: "vix", symbol: "^VIX", name: "VIX 恐怖指数", group: "us", invert: true },

  { key: "ym_fut", symbol: "YM=F", name: "NYダウ先物", group: "fut" },
  { key: "es_fut", symbol: "ES=F", name: "S&P500先物", group: "fut" },
  { key: "nq_fut", symbol: "NQ=F", name: "NASDAQ100先物", group: "fut" },
  { key: "vx_fut", source: "cboe_vx", name: "VIX先物 期近", group: "fut", invert: true, digits: 2 },

  { key: "dax", symbol: "^GDAXI", name: "独 DAX", group: "eu" },
  { key: "ftse", symbol: "^FTSE", name: "英 FTSE100", group: "eu" },
  { key: "cac", symbol: "^FCHI", name: "仏 CAC40", group: "eu" },
  { key: "sx5e", symbol: "^STOXX50E", name: "ユーロ・ストックス50", group: "eu" },

  { key: "sse", symbol: "000001.SS", name: "上海総合", group: "asia" },
  { key: "hsi", symbol: "^HSI", name: "香港ハンセン", group: "asia" },
  { key: "kospi", symbol: "^KS11", name: "韓国 KOSPI", group: "asia" },
  { key: "twii", symbol: "^TWII", name: "台湾 加権", group: "asia" },
  { key: "nifty", symbol: "^NSEI", name: "インド Nifty50", group: "asia" },
  { key: "asx", symbol: "^AXJO", name: "豪 ASX200", group: "asia" },

  { key: "usdjpy", symbol: "JPY=X", name: "ドル円", group: "fx", digits: 2 },
  { key: "eurjpy", symbol: "EURJPY=X", name: "ユーロ円", group: "fx", digits: 2 },
  { key: "eurusd", symbol: "EURUSD=X", name: "ユーロドル", group: "fx", digits: 4 },
  { key: "dxy", symbol: "DX-Y.NYB", name: "ドル指数", group: "fx", digits: 2 },

  { key: "us10y", symbol: "^TNX", name: "米10年債 利回り", group: "rate", digits: 3 },
  { key: "us5y", symbol: "^FVX", name: "米5年債 利回り", group: "rate", digits: 3 },
  { key: "jp10y", source: "mof", name: "日本10年債 利回り", group: "rate", digits: 3,
    note: "財務省公表の日次データ（前営業日の値）" },

  { key: "wti", symbol: "CL=F", name: "WTI原油", group: "cmd" },
  { key: "gold", symbol: "GC=F", name: "金", group: "cmd" },
  { key: "silver", symbol: "SI=F", name: "銀", group: "cmd", digits: 3 },
  { key: "copper", symbol: "HG=F", name: "銅", group: "cmd", digits: 4 },
  { key: "natgas", symbol: "NG=F", name: "天然ガス", group: "cmd", digits: 3 },

  { key: "btc", symbol: "BTC-USD", name: "ビットコイン", group: "crypto", digits: 0 },
  { key: "eth", symbol: "ETH-USD", name: "イーサリアム", group: "crypto", digits: 1 },
];

export const makeItems = (watchlist) => [
  ...SYMBOLS,
  ...watchlist.map((w) => ({ key: "w:" + w.symbol, symbol: w.symbol, name: w.name || w.symbol, group: "watch", removable: true })),
];

const RANGES = {
  "1d": { range: "1d", interval: "5m" },
  "5d": { range: "5d", interval: "30m" },
  "1mo": { range: "1mo", interval: "1d", days: 31 },
  "3mo": { range: "3mo", interval: "1d", days: 92 },
  "6mo": { range: "6mo", interval: "1d", days: 183 },
  "1y": { range: "1y", interval: "1d", days: 366 },
};

const DAILY_TTL = 15 * 60e3;
const MOF_TTL = 60 * 60e3;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// プロセス（Workers なら isolate）内のメモリキャッシュ。消えても困らないものだけ置く
const mem = new Map();
async function cached(key, ttl, fn) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  try {
    const value = await fn();
    mem.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true }; // 失敗時は前回値を返す
    throw e;
  }
}

// 問い合わせ回数の上限つき fetch
function get(ctx, url, init) {
  if (ctx.left <= 0) throw new Error("問い合わせ回数の上限に達しました");
  ctx.left--;
  return fetch(url, init);
}

/* ---------- データの異常値除去 ---------- */
// Yahooのデータには、まれに1日だけ1/10になる等の明らかな誤りがある（例: 1306.T の 2026/3/30-31）。
// 直前の値から大きく外れ、数本以内に元の水準へ戻る点は除外する。
function dropSpikes(points, tol = 0.2) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = out.at(-1)?.v;
    const next = points.slice(i + 1, i + 4).map((q) => q.v);
    if (prev != null && next.length) {
      const offPrev = Math.abs(p.v / prev - 1) > tol;
      const backNearPrev = next.some((n) => Math.abs(n / prev - 1) < tol / 2);
      if (offPrev && backNearPrev) continue;
    }
    // 高値・安値が終値からかけ離れている足は、始値/終値で丸める
    if (p.h != null && (p.h > p.v * (1 + tol) || p.l < p.v * (1 - tol) || p.o > p.v * (1 + tol) || p.o < p.v * (1 - tol))) {
      const o = Math.abs(p.o / p.v - 1) > tol ? p.v : p.o;
      out.push({ ...p, o, h: Math.max(o, p.v), l: Math.min(o, p.v) });
      continue;
    }
    out.push(p);
  }
  return out;
}

/* ---------- Yahoo Finance ---------- */
// 短時間に叩くと429を返すので、リトライ＋キャッシュで回数を抑える
async function yahooFetch(ctx, url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await get(ctx, url);
    if (res.status === 429) { await wait(1500 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error("アクセス制限中（少し待って更新してください）");
}

async function yahooChart(ctx, symbol, range, interval) {
  const j = await yahooFetch(ctx, `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`);
  const r = j.chart.result[0];
  const { open, high, low, close } = r.indicators.quote[0];
  const series = (r.timestamp || [])
    .map((t, i) => ({ t: t * 1000, v: close[i], o: open?.[i] ?? close[i], h: high?.[i] ?? close[i], l: low?.[i] ?? close[i] }))
    .filter((p) => p.v != null && p.v > 0);
  return { meta: r.meta, series: dropSpikes(series) };
}

// 複数銘柄の終値をまとめて取得（1回最大20銘柄）。銘柄ごとにメモリキャッシュ
async function sparkMany(ctx, symbols, range, interval, ttl) {
  const out = {};
  const need = [];
  for (const s of symbols) {
    const hit = mem.get(`spark:${range}:${s}`);
    if (hit && Date.now() - hit.at < ttl) out[s] = hit.value;
    else need.push(s);
  }
  for (let i = 0; i < need.length; i += 15) {
    const chunk = need.slice(i, i + 15);
    let j = {};
    try {
      j = await yahooFetch(ctx, `https://query2.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(chunk.join(","))}&range=${range}&interval=${interval}`);
    } catch {}
    for (const s of chunk) {
      let v = null;
      const r = j[s];
      if (r) {
        // 休場で空の場合も「空」としてキャッシュし、無駄な再取得を避ける
        const pts = (r.timestamp || []).map((t, k) => ({ t: t * 1000, v: r.close[k] })).filter((p) => p.v != null && p.v > 0);
        v = { series: dropSpikes(pts), prevClose: r.chartPreviousClose ?? r.previousClose };
      } else if (ctx.left > 12) {
        // まとめ取得で漏れた銘柄は個別に取得（問い合わせ回数に余裕があるときだけ）
        try {
          const c = await yahooChart(ctx, s, range, interval);
          v = { series: c.series.map(({ t, v }) => ({ t, v })), prevClose: c.meta.chartPreviousClose ?? c.meta.previousClose };
        } catch {}
      }
      if (v) {
        mem.set(`spark:${range}:${s}`, { at: Date.now(), value: v });
        out[s] = v;
      } else {
        const hit = mem.get(`spark:${range}:${s}`);
        if (hit) out[s] = hit.value; // 失敗時は前回値
      }
    }
  }
  return out;
}

export async function search(ctx, q) {
  return cached(`search:${q}`, 3600e3, async () => {
    const j = await yahooFetch(ctx, `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`);
    return (j.quotes || [])
      .filter((x) => x.symbol && ["EQUITY", "ETF", "INDEX", "MUTUALFUND", "FUTURE", "CURRENCY", "CRYPTOCURRENCY"].includes(x.quoteType))
      .map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchDisp || x.exchange, type: x.typeDisp || x.quoteType }));
  });
}

// ウォッチリスト追加前の確認：データが取れるか＋正式名称
export async function probeSymbol(ctx, symbol) {
  const { series, meta } = await yahooChart(ctx, symbol, "5d", "1d");
  if (!series.length) throw new Error(`${symbol} のデータが取得できません`);
  return { name: meta.shortName || meta.longName || symbol };
}

/* ---------- 財務省 国債金利（日本10年債） ---------- */
// CSVはShift_JISだが、必要な行（基準日・数値）はASCIIのみなのでそのまま読める。
// 基準日は和暦（例: R8.11.12）。令和(R)のみ対象＝直近数年分で十分
function parseMofCsv(buf) {
  const text = new TextDecoder().decode(buf);
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split(",");
    const m = /^R(\d+)\.(\d+)\.(\d+)$/.exec(cols[0]);
    if (!m) continue;
    const v = parseFloat(cols[10]); // 10年
    if (Number.isNaN(v)) continue;
    out.push([Date.UTC(2018 + +m[1], +m[2] - 1, +m[3], 6), v]); // JST 15:00
  }
  return out;
}
async function fetchMof(ctx) {
  const one = async (url) => {
    const res = await get(ctx, url);
    if (!res.ok) throw new Error(`財務省CSV HTTP ${res.status}`);
    return parseMofCsv(await res.arrayBuffer());
  };
  const [hist, cur] = await Promise.all([
    one("https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv"),
    one("https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv"),
  ]);
  const map = new Map();
  for (const [t, v] of [...hist, ...cur]) map.set(t, v);
  return [...map].sort((a, b) => a[0] - b[0]).slice(-400);
}

/* ---------- CBOE VIX先物 ---------- */
async function vixCurve(ctx) {
  return cached("cboe:vx", 5 * 60e3, async () => {
    const res = await get(ctx, "https://www.cboe.com/us/futures/api/get_quotes_combined/?symbol=VX&rootsymbol=null");
    if (!res.ok) throw new Error(`CBOE HTTP ${res.status}`);
    const rows = (await res.json()).data || [];
    const now = Date.now();
    // 月次限月のみ（VX/X6 形式。VX47/X6 のような週次は除外）
    const months = rows
      .filter((r) => /^VX\/[A-Z]\d$/.test(r.symbol))
      .map((r) => {
        const [mm, dd, yyyy] = r.expiration.split("/").map(Number);
        const live = r.last_price > 0 && r.prev_close > 0;
        return {
          symbol: r.symbol,
          exp: Date.UTC(yyyy, mm - 1, dd, 21),
          label: `${yyyy % 100}/${mm}限`,
          price: live ? r.last_price : r.settlement,
          prev: live ? r.prev_close : r.prev_settlement,
        };
      })
      .filter((r) => r.exp >= now && r.price > 0) // 満期日の米国引け後に次の限月へ
      .sort((a, b) => a.exp - b.exp);
    if (!months.length) throw new Error("VIX先物データなし");
    return { months };
  });
}

/* ---------- TradingView スキャナー（大阪 日経225mini先物） ---------- */
// 価格・前日比・始値・高値・安値のみ（過去データなし）
async function tvQuote(ctx, ticker) {
  return cached("tv:" + ticker, 3 * 60e3, async () => {
    const res = await get(ctx, "https://scanner.tradingview.com/global/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: { tickers: [ticker] }, columns: ["close", "change", "change_abs", "open", "high", "low"] }),
    });
    if (!res.ok) throw new Error(`TradingView HTTP ${res.status}`);
    const row = (await res.json()).data?.[0];
    if (!row) throw new Error("データなし");
    const [close, pct, abs, open, high, low] = row.d;
    return { price: close, change: abs, changePct: pct, prevClose: close - abs, open, high, low };
  });
}

/* ---------- 日足の更新（保存データ） ---------- */
// 同時に投げすぎないよう limit 本ずつ処理
async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

// 古くなった日足を最大 max 銘柄ぶん取り直す。onlyMissing なら未取得の銘柄だけ。
// 変更があれば true を返す（呼び出し側で保存する）
export async function refreshDaily(ctx, store, items, { max = Infinity, onlyMissing = false, force = false, log = [] } = {}) {
  store.daily ??= {};
  let changed = false;
  const now = Date.now();
  const ttl = force ? 5 * 60e3 : DAILY_TTL;

  if (items.some((s) => s.source === "mof") && (!store.mof || (!onlyMissing && now - store.mof.at > MOF_TTL))) {
    try { store.mof = { at: now, rows: await fetchMof(ctx) }; changed = true; } catch (e) { log.push(`mof: ${e.message}`); }
  }

  const syms = [...new Set(items.filter((s) => !s.source).map((s) => s.symbol))];
  const todo = syms
    .filter((s) => (onlyMissing ? !store.daily[s] : !store.daily[s] || now - store.daily[s].at > ttl))
    .sort((a, b) => (store.daily[a]?.at ?? 0) - (store.daily[b]?.at ?? 0)) // 古い順
    .slice(0, max);
  await mapLimit(todo, 3, async (sym) => {
    if (ctx.left < 3) { log.push(`${sym}: 問い合わせ上限のため次回`); return; }
    try {
      const { series, meta } = await yahooChart(ctx, sym, "1y", "1d");
      if (series.length > 1) {
        store.daily[sym] = { at: Date.now(), name: meta.shortName || meta.longName, rows: series.map((p) => [p.t, p.v, p.o, p.h, p.l]) };
        changed = true;
      }
    } catch (e) { log.push(`${sym}: ${e.message}`); }
  });

  // ウォッチリストから外した銘柄は掃除
  for (const s of Object.keys(store.daily)) if (!syms.includes(s)) { delete store.daily[s]; changed = true; }
  return changed;
}

/* ---------- タイル用サマリー ---------- */
const pairs = (pts) => pts.map((p) => [p.t, p.v]);

function build(s, intra, rows) {
  // 価格＝直近値、前日比＝前日終値との比較。日中データがなければ日足の最後の2本で計算
  const useIntra = intra && !intra.chartOnly && intra.series.length;
  if (!useIntra && rows.length < 2) throw new Error("データなし");
  const last = useIntra ? intra.series.at(-1).v : rows.at(-1)[1];
  const prev = (useIntra && intra.prevClose) || rows.at(-2)?.[1];
  return {
    ...s,
    price: last,
    prevClose: prev,
    change: last - prev,
    changePct: ((last - prev) / prev) * 100,
    asOf: intra?.series.at(-1)?.t ?? rows.at(-1)?.[0],
    intraday: intra ? pairs(intra.series) : null,
    daily: rows.slice(-260),
  };
}

export async function market(ctx, store, items, { force = false } = {}) {
  const syms = [...new Set(items.filter((s) => !s.source).map((s) => s.symbol))];
  const intra = await sparkMany(ctx, syms, "1d", "5m", force ? 60e3 : 3 * 60e3);

  // 週末・休場日は先物などで「1日」が空になるので、5日分から直近の取引セッションを切り出す
  const missing = syms.filter((s) => !(intra[s]?.series.length > 1));
  if (missing.length) {
    const five = await sparkMany(ctx, missing, "5d", "5m", force ? 60e3 : 3 * 60e3);
    for (const s of missing) {
      const all = five[s]?.series;
      if (!all || all.length < 2) continue;
      let cut = all.length - 1; // 50分以上の空白をセッションの区切りとみなす（CME先物の日次休止も含む）
      while (cut > 0 && all[cut].t - all[cut - 1].t < 50 * 60e3) cut--;
      // 前日比は日足（清算値ベース）で計算し、このデータはミニチャートの形にだけ使う
      if (cut > 0) intra[s] = { series: all.slice(cut), chartOnly: true };
    }
  }

  const quotes = await Promise.all(items.map(async (s) => {
    try {
      if (s.source === "mof") {
        if (!store.mof) throw new Error("データ準備中");
        return build(s, null, store.mof.rows);
      }
      if (s.source === "tv") return { ...s, ...(await tvQuote(ctx, s.tv)), asOf: null };
      if (s.source === "cboe_vx") {
        const { months, stale } = await vixCurve(ctx);
        const [m1, m2] = months;
        return {
          ...s,
          name: `VIX先物 ${m1.label}`,
          price: m1.price,
          prevClose: m1.prev,
          change: m1.price - m1.prev,
          changePct: ((m1.price - m1.prev) / m1.prev) * 100,
          months,
          structure: m2 ? (m2.price >= m1.price ? "contango" : "backwardation") : null,
          stale,
        };
      }
      // コード指定で追加した銘柄は、取得時にわかった正式名称で表示
      const name = s.removable && s.name === s.symbol ? store.daily?.[s.symbol]?.name || s.name : s.name;
      return build({ ...s, name }, intra[s.symbol], store.daily?.[s.symbol]?.rows ?? []);
    } catch (e) {
      return { ...s, error: e.message };
    }
  }));
  const dailyAt = Object.values(store.daily || {}).map((d) => d.at);
  return { fetchedAt: Date.now(), dailyAt: dailyAt.length ? Math.min(...dailyAt) : null, quotes };
}

/* ---------- 大きいチャート用 ---------- */
export async function chart(ctx, store, item, rangeKey) {
  const r = RANGES[rangeKey];
  if (!item || !r) throw new Error("bad params");
  const key = item.key;

  if (item.source === "cboe_vx") {
    const { months } = await vixCurve(ctx);
    const spot = mem.get("spark:1d:^VIX")?.value.series.at(-1)?.v ?? store.daily?.["^VIX"]?.rows.at(-1)?.[1] ?? null;
    return { key, kind: "curve", months, spot };
  }
  if (item.source === "mof") {
    // 日次データのみ。1日/5日は直近5営業日、それ以外は期間で切り出し
    const all = store.mof?.rows ?? [];
    const from = r.days ? Date.now() - r.days * 86400e3 : null;
    const series = from ? all.filter((p) => p[0] >= from) : all.slice(-5);
    return { key, range: rangeKey, daily: true, series };
  }
  if (item.noChart) throw new Error("この銘柄はチャート非対応です");

  const ttl = rangeKey === "1d" || rangeKey === "5d" ? 5 * 60e3 : 30 * 60e3;
  return cached(`chart:${key}:${rangeKey}`, ttl, async () => {
    let { meta, series } = await yahooChart(ctx, item.symbol, r.range, r.interval);
    let prevClose = meta.chartPreviousClose ?? meta.previousClose;
    if (rangeKey === "1d" && series.length < 2) {
      // 週末・休場日は1日分が空になるので、直近の取引セッションを表示
      const all = (await yahooChart(ctx, item.symbol, "5d", "5m")).series;
      let cut = all.length - 1; // 50分以上の空白をセッションの区切りとみなす（CME先物の日次休止も含む）
      while (cut > 0 && all[cut].t - all[cut - 1].t < 50 * 60e3) cut--;
      series = all.slice(cut);
      prevClose = cut > 0 ? all[cut - 1].v : null;
    }
    return {
      key, range: rangeKey, intraday: rangeKey === "1d" || rangeKey === "5d",
      prevClose,
      ohlc: true,
      // [時刻, 終値, 始値, 高値, 安値]
      series: series.map((p) => [p.t, p.v, p.o, p.h, p.l]),
    };
  });
}
