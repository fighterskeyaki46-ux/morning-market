// ローカル（Mac）で動かす版。処理の中身は src/core.js を Workers 版と共用
// 起動: node server.js  →  http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./src/core.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const WATCHLIST_FILE = path.join(DIR, "watchlist.json");
const INDEX = path.join(DIR, "public", "index.html");

function loadWatchlist() {
  try { return JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8")); } catch { return []; }
}
let watchlist = loadWatchlist(); // [{ symbol, name }]
const saveWatchlist = () => fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2));
const items = () => core.makeItems(watchlist);

// 日足などの保存データ（ローカルではメモリ上に持つだけ）
const store = { daily: {} };
// ローカルは問い合わせ回数の制限なし
const newCtx = () => ({ left: Infinity });

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 1e5) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch (e) { reject(e); } });
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const c = newCtx();
    try {
      if (p === "/api/market") {
        const force = url.searchParams.has("refresh");
        await core.refreshDaily(c, store, items(), { force });
        return json(res, 200, await core.market(c, store, items(), { force }));
      }
      if (p === "/api/chart") {
        const item = items().find((s) => s.key === url.searchParams.get("key"));
        return json(res, 200, await core.chart(c, store, item, url.searchParams.get("range") || "1y"));
      }
      if (p === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim();
        return json(res, 200, q ? await core.search(c, q) : []);
      }
      if (p === "/api/watchlist" && req.method === "POST") {
        const { symbol, name } = await readBody(req);
        if (!symbol || typeof symbol !== "string") return json(res, 400, { error: "symbol required" });
        if (!watchlist.some((w) => w.symbol === symbol)) {
          const info = await core.probeSymbol(c, symbol);
          watchlist.push({ symbol, name: name || info.name });
          saveWatchlist();
        }
        return json(res, 200, { ok: true });
      }
      if (p === "/api/watchlist" && req.method === "DELETE") {
        const symbol = url.searchParams.get("symbol");
        watchlist = watchlist.filter((w) => w.symbol !== symbol);
        saveWatchlist();
        return json(res, 200, { ok: true });
      }
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(INDEX).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Morning Market → http://localhost:${PORT}`));
