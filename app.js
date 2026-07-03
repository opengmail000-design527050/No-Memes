/* No进度欺诈 web 版 —— progress_query.py 的浏览器移植。
 * 纯静态、用户自带 FFLogs client 凭据（localStorage），查询直连 cn.fflogs.com（CORS 已验证）。 */
"use strict";

/* ============ 常量（来自 fflogs_query.py） ============ */
const ULT_ZONES = [19, 23, 32, 45, 53, 65, 76, 30, 43, 59]; // 含旧绝本 grouping zone
const IMMUTABLE_MS = 48 * 3600 * 1000;   // 报告开播 48h 后视为不可变
const WEEK_MS = 7 * 86400 * 1000;
const LAST_TTL = 15 * 60 * 1000;         // 同角色同副本 15 分钟内直接复用结果，零请求
const BATCH = 10;                        // 报告扫描别名批量大小（实测点数最优）

// 副本选择（只绝本，FFLogs 国服完整名，新→旧）
const ZONE_TABS = [
  { id: 76, label: "妖星乱舞绝境战" },
  { id: 65, label: "光暗未来绝境战" },
  { id: 53, label: "欧米茄绝境验证战" },
  { id: 45, label: "幻想龙诗绝境战" },
  { id: 32, label: "亚历山大绝境战" },
  { id: 23, label: "究极神兵绝境战" },
  { id: 19, label: "巴哈姆特绝境战" },
];

const JOB_ZH = {
  Paladin: "骑士", Warrior: "战士", DarkKnight: "暗黑骑士", Gunbreaker: "绝枪战士",
  WhiteMage: "白魔法师", Scholar: "学者", Astrologian: "占星术士", Sage: "贤者",
  Monk: "武僧", Dragoon: "龙骑士", Ninja: "忍者", Samurai: "武士", Reaper: "钐镰客",
  Viper: "蝰蛇剑士", Bard: "吟游诗人", Machinist: "机工士", Dancer: "舞者",
  BlackMage: "黑魔法师", Summoner: "召唤师", RedMage: "赤魔法师", Pictomancer: "绘灵法师",
  BlueMage: "青魔法师", Gladiator: "剑术师", Marauder: "斧术师", Conjurer: "幻术师",
  Thaumaturge: "咒术师", Arcanist: "秘术师", Pugilist: "格斗家", Lancer: "枪术师",
  Rogue: "双剑师", Archer: "弓箭手",
};
const TANKS = new Set(["Paladin", "Warrior", "DarkKnight", "Gunbreaker", "Gladiator", "Marauder"]);
const HEALS = new Set(["WhiteMage", "Scholar", "Astrologian", "Sage", "Conjurer"]);
const roleOf = j => TANKS.has(j) ? "tank" : HEALS.has(j) ? "heal" : "dps";
const ROLE_ORDER = { tank: 0, heal: 1, dps: 2 };

// 中日异体字（FF14 角色名高频）
const CJK_VARIANTS = {
  "黒": "黑", "黑": "黒", "桜": "樱", "樱": "桜", "龍": "龙", "龙": "龍",
  "凜": "凛", "凛": "凜", "渊": "淵", "淵": "渊", "莲": "蓮", "蓮": "莲",
  "灯": "燈", "燈": "灯", "顔": "颜", "颜": "顔", "鴎": "鸥", "鸥": "鴎",
  "気": "气", "气": "気", "両": "两", "两": "両", "歩": "步", "步": "歩",
};

/* ============ 小工具 ============ */
const norm = s => (s || "").trim().toLowerCase().replace(/黒/g, "黑");

function nameCandidates(name) {
  let cands = [name];
  for (let i = 0; i < name.length; i++) {
    const alt = CJK_VARIANTS[name[i]];
    if (!alt) continue;
    cands = cands.concat(cands.map(c => c.slice(0, i) + alt + c.slice(i + 1)));
    if (cands.length > 16) break;
  }
  return [...new Set(cands)];
}

const pad = n => String(n).padStart(2, "0");
function fmtCST(ms, full) {
  if (!ms) return null;
  const d = new Date(ms + 8 * 3600 * 1000);  // CST = UTC+8，用 UTC getter 定格
  const md = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return full ? `${d.getUTCFullYear()}-${md}` : md;
}
const round2 = x => (x == null ? null : Math.round(x * 100) / 100);
const rankLess = (a, b) => a[0] !== b[0] ? a[0] - b[0] < 0 : a[1] - b[1] < 0;

/* ============ localStorage 状态 ============ */
const LS = {
  get(k, dft) { try { return JSON.parse(localStorage.getItem(k)) ?? dft; } catch { return dft; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};
let config = LS.get("fpw_config", { clientId: "", clientSecret: "", base: "https://cn.fflogs.com" });
const cache = LS.get("fpw_cache", {});
for (const k of ["scans", "reports", "resolve", "servers", "last"]) cache[k] ??= {};
let history = LS.get("fpw_history", []);

function saveCache() {
  const keys = Object.keys(cache.scans);
  if (keys.length > 2000) {  // ponytail: 按写入时间截断，防 localStorage 撑爆
    keys.sort((a, b) => cache.scans[a].ts - cache.scans[b].ts)
      .slice(0, keys.length - 2000).forEach(k => delete cache.scans[k]);
  }
  try { LS.set("fpw_cache", cache); } catch {
    cache.scans = {}; cache.reports = {};   // reports 才是大头（单角色可上百 KB）
    try { LS.set("fpw_cache", cache); } catch {}
  }
}

/* ============ FFLogs 客户端 ============ */
class FFLogsError extends Error {}

async function ensureToken() {
  const t = LS.get("fpw_token", null);
  if (t && t.base === config.base && t.id === config.clientId && Date.now() < t.exp - 60000) return t.token;
  if (!config.clientId || !config.clientSecret) throw new FFLogsError("NEED_CONFIG");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const r = await fetch(config.base + "/oauth/token", { method: "POST", body });
  if (!r.ok) throw new FFLogsError(`OAuth 失败（HTTP ${r.status}）——检查 Client ID / Secret 是否正确`);
  const p = await r.json();
  LS.set("fpw_token", { token: p.access_token, exp: Date.now() + (p.expires_in || 3600) * 1000, base: config.base, id: config.clientId });
  return p.access_token;
}

async function gql(query, variables) {
  const token = await ensureToken();
  const r = await fetch(config.base + "/api/v2/client", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  if (r.status === 401) { localStorage.removeItem("fpw_token"); throw new FFLogsError("凭据失效，请重新保存 API 设置"); }
  if (r.status === 429) throw new FFLogsError("FFLogs 限流（本小时点数用完），稍后再试");
  if (!r.ok) throw new FFLogsError(`FFLogs 请求失败（HTTP ${r.status}）`);
  const data = await r.json();
  // 批量别名查询（31 服探测等）里个别字段出错（如隐藏角色）不拖垮整次请求：有部分数据就用部分数据
  if (data.errors && !data.data) throw new FFLogsError("GraphQL: " + data.errors.map(e => e.message).join("; "));
  return data.data || {};
}

/* ============ 副本元数据（encounter → 中文名 / 逻辑 boss 分组） ============ */
let encMetaPromise = null;
async function encMeta() {
  return encMetaPromise ??= (async () => {
    const zones = [...ULT_ZONES];
    const sig = zones.join(",");
    const hit = LS.get("fpw_encmeta", null);
    let meta = null;
    if (hit && hit.sig === sig && Date.now() - hit.ts < 7 * 86400 * 1000) meta = hit.meta;
    if (!meta) {
      const alias = zones.map(z => `z${z}: zone(id:${z}){ encounters{ id name } }`).join("\n");
      try {
        const w = (await gql(`query{ worldData{ ${alias} }}`)).worldData || {};
        meta = {};
        for (const z of zones) {
          for (const e of (w["z" + z]?.encounters || [])) meta[e.id] = { name: e.name, kind: "ultimate", zone: z };
        }
        LS.set("fpw_encmeta", { sig, ts: Date.now(), meta });
      } catch (e) {
        if (hit && hit.sig === sig) meta = hit.meta;   // 限流退回过期缓存
        else throw e;
      }
    }
    // 同名 encounter 合并成逻辑 boss（旧绝本跨版本多个 era id）
    const groups = {};
    for (const [eid, m] of Object.entries(meta)) {
      const g = groups[m.name] ??= { name: m.name, kind: m.kind, eids: [], zones: new Set() };
      g.eids.push(+eid);
      g.zones.add(m.zone);
    }
    return { meta, groups: Object.values(groups) };
  })();
}

/* ============ 角色解析（异体字 + 免服务器 31 服探测） ============ */
async function cnServers() {
  const hit = cache.servers.CN;
  if (hit && Date.now() - hit.ts < 30 * 86400 * 1000) return hit.v;
  const regs = (await gql("{worldData{regions{id slug}}}")).worldData?.regions || [];
  const rid = regs.find(r => r.slug === "CN")?.id;
  if (rid == null) throw new FFLogsError("FFLogs 上没有 CN 大区");
  const d = await gql("query($id:Int!){worldData{region(id:$id){subregions{servers(limit:100){data{name}}}}}}", { id: rid });
  const names = (d.worldData?.region?.subregions || []).flatMap(s => (s.servers?.data || []).map(x => x.name));
  if (names.length) cache.servers.CN = { ts: Date.now(), v: names };
  return names;
}

async function probeServers(name, servers) {
  const alias = servers.map((s, i) =>
    `s${i}: character(name:${JSON.stringify(name)},serverSlug:${JSON.stringify(s)},serverRegion:"CN"){ name server{ name } recentReports(limit:1){ data{ startTime } } }`
  ).join("\n");
  const cd = (await gql(`query{ characterData{ ${alias} }}`)).characterData || {};
  const hits = [];
  servers.forEach((srv, i) => {
    const ch = cd["s" + i];
    if (!ch) return;
    hits.push({ name: ch.name, server: ch.server?.name || srv, lastTs: ch.recentReports?.data?.[0]?.startTime || 0 });
  });
  return hits;
}

async function searchCharacter(name) {
  const servers = await cnServers();
  const cands = nameCandidates(name);
  const normset = new Set(cands.map(norm));
  let hits = [], anyOk = false, lastErr = null;
  for (const cand of cands.slice(0, 4)) {
    try { hits = await probeServers(cand, servers); } catch (e) { lastErr = e; continue; }
    anyOk = true;
    if (hits.length) break;
  }
  if (!anyOk && lastErr) throw lastErr;
  const active = hits.filter(h => h.lastTs > 0);   // 没传过 log 的没进度可查
  if (!active.length) return { hits: hits };
  // 名字精确命中优先（FFLogs 会把改过名的老角色也匹配出来），再按最近上传排
  active.sort((a, b) => (normset.has(norm(a.name)) ? 0 : 1) - (normset.has(norm(b.name)) ? 0 : 1) || b.lastTs - a.lastTs);
  const best = active[0];
  const others = active.slice(1).filter(h => normset.has(norm(h.name))).map(h => h.server);
  const note = others.length
    ? `已自动定位到最近活跃的 ${best.server}；${others.join("、")} 也有同名角色，查错了请用「角色名@服务器」精确指定。`
    : null;
  return { name: best.name, server: best.server, note, hits: active };
}

async function resolveCharacter(name, server) {
  const ck = [norm(name), norm(server) || "*", "CN"].join("|");
  const hit = cache.resolve[ck];
  if (hit && Date.now() - hit.ts < 30 * 86400 * 1000) return { name: hit.v[0], server: hit.v[1], note: null };
  if (!server) {
    const r = await searchCharacter(name);
    if (r.name) cache.resolve[ck] = { ts: Date.now(), v: [r.name, r.server] };
    return r.name ? r : { name: null };
  }
  let anyOk = false, lastErr = null;
  for (const cand of nameCandidates(name)) {
    let d;
    try {
      d = await gql("query($n:String!,$s:String!){characterData{character(name:$n,serverSlug:$s,serverRegion:\"CN\"){ name server{ name } }}}", { n: cand, s: server });
    } catch (e) { lastErr = e; continue; }
    anyOk = true;
    const ch = d.characterData?.character;
    if (ch) {
      const v = [ch.name, ch.server?.name || server];
      cache.resolve[ck] = { ts: Date.now(), v };
      return { name: v[0], server: v[1], note: null };
    }
  }
  if (!anyOk && lastErr) throw lastErr;   // 全是限流/网络错 ≠ 角色不存在
  return { name: null };
}

/* ============ 报告列表 + 扫描（含缓存/批量，同 Python 版三刀） ============ */
const REPORT_FIELDS = `startTime
  masterData{ actors(type:"Player"){ id name server subType } }
  fights{ id encounterID name kill fightPercentage bossPercentage lastPhase startTime friendlyPlayers }`;

function parseReport(rep, code, wname, wserver, meta) {
  const base = rep.startTime || 0;
  const actors = rep.masterData?.actors || [];
  const actorMap = new Map(actors.map(a => [a.id, a]));
  const myIds = new Set(actors.filter(a =>
    norm(a.name) === wname && (!a.server || norm(a.server) === wserver)).map(a => a.id));
  if (!myIds.size) return {};
  const out = {};
  for (const f of rep.fights || []) {
    const eid = f.encounterID;
    if (!eid) continue;
    const fp = f.friendlyPlayers || [];
    const mine = fp.filter(id => myIds.has(id));
    if (!mine.length) continue;                    // 本人没上这把（社区聚合报告过滤，关键）
    const rank = [f.kill ? 0 : 1, f.fightPercentage ?? 999];
    const cur = out[eid];
    if (cur && !rankLess(rank, cur.rank)) continue;
    const m = meta[eid];
    const party = fp.map(id => actorMap.get(id) || {})
      .filter(a => a.subType !== "LimitBreak")
      .map(a => ({ name: a.name, server: a.server, job: a.subType, me: myIds.has(a.id) }))
      .sort((a, b) => ROLE_ORDER[roleOf(a.job)] - ROLE_ORDER[roleOf(b.job)]);
    out[eid] = {
      rank, eid,
      name: m ? m.name : (f.name || "?"),
      kind: m ? m.kind : "other",
      cleared: !!f.kill,
      phase: f.lastPhase,
      hp: round2(f.bossPercentage),
      fp: f.fightPercentage,
      timeMs: base + (f.startTime || 0),
      code, fightId: f.id,
      job: actorMap.get(mine[0])?.subType,
      party,
    };
  }
  return out;
}

async function scanReports(items, wname, wserver, meta) {
  const out = [], misses = [];
  for (const it of items) {
    const hit = cache.scans[`${it.code}|${wname}|${wserver}`];
    if (hit) out.push(hit.r); else misses.push(it);
  }
  if (!misses.length) return out;
  const chunks = [];
  for (let i = 0; i < misses.length; i += BATCH) chunks.push(misses.slice(i, i + BATCH));
  const results = await Promise.all(chunks.map(async chunk => {
    const alias = chunk.map((it, i) => `r${i}: report(code:${JSON.stringify(it.code)}){ ${REPORT_FIELDS} }`).join("\n");
    try {
      const rd = (await gql(`query{ reportData{ ${alias} }}`)).reportData || {};
      return chunk.map((it, i) => parseReport(rd["r" + i] || {}, it.code, wname, wserver, meta));
    } catch { return chunk.map(() => null); }   // 整批失败：不缓存，当空处理
  }));
  chunks.forEach((chunk, ci) => chunk.forEach((it, i) => {
    const p = results[ci][i];
    if (p == null) { out.push({}); return; }
    if (it.ts && Date.now() - it.ts > IMMUTABLE_MS)
      cache.scans[`${it.code}|${wname}|${wserver}`] = { ts: Date.now(), r: p };
    out.push(p);
  }));
  return out;
}

// 翻角色报告列表（增量缓存 + 早停）。untilTs：保证列表至少覆盖到这个时间点（周最佳用）。
async function characterReports(name, server, { zones, need, untilTs }) {
  const Q = `query($n:String!,$s:String!,$p:Int!){
    characterData{ character(name:$n,serverSlug:$s,serverRegion:"CN"){
      recentReports(limit:50,page:$p){ last_page data{ code startTime zone{ id } } }}}}`;
  const fetchPage = async p => {
    const ch = (await gql(Q, { n: name, s: server, p })).characterData?.character;
    if (!ch) return null;
    return {
      lastPage: ch.recentReports?.last_page || 1,
      rows: (ch.recentReports?.data || []).map(x => ({ code: x.code, zone: x.zone?.id, ts: x.startTime })),
    };
  };
  const enough = rows => {
    if (untilTs && rows.length && (rows[rows.length - 1].ts || 0) > untilTs) return false;
    return rows.filter(r => zones.has(r.zone)).length >= need;
  };
  const first = await fetchPage(1);
  if (!first) return null;
  let rows = first.rows;
  const ck = norm(`${name}@${server}`) + "|CN";
  const last = Math.min(first.lastPage, 40);

  const cached = cache.reports[ck];
  if (cached && last > 1 && rows.length) {
    const cachedCodes = new Set(cached.rows.map(r => r.code));
    if (cachedCodes.has(rows[rows.length - 1].code)) {     // 第 1 页与缓存无缝衔接
      const codes1 = new Set(rows.map(r => r.code));
      const merged = rows.concat(cached.rows.filter(r => !codes1.has(r.code)));
      if (cached.complete || enough(merged)) {
        cache.reports[ck] = { ts: Date.now(), rows: merged, complete: !!cached.complete };
        return merged;
      }
      rows = merged;
    }
  }
  let covered = 1;
  while (covered < last && !enough(rows)) {   // 4 页一波并发，凑够早停
    const wave = [];
    for (let p = covered + 1; p <= Math.min(covered + 4, last); p++) wave.push(p);
    (await Promise.all(wave.map(fetchPage))).forEach(res => { if (res) rows = rows.concat(res.rows); });
    covered = wave[wave.length - 1];
  }
  cache.reports[ck] = { ts: Date.now(), rows, complete: covered >= last };
  return rows;
}

/* ============ 查询编排 ============ */
// 先判通关；通关→最近一周最远那把；未通关→扫最近 40 份找最远
async function zoneProgress(name, server, zoneId) {
  const { groups } = await encMeta();
  const glist = groups.filter(g => g.zones.has(zoneId));
  if (!glist.length) throw new FFLogsError("这个副本没有 encounter 数据");

  // ① 通关判定：所有 era id 合并成一次查询
  const alias = glist.flatMap(g => g.eids.map(eid =>
    `e${eid}: encounterRankings(encounterID:${eid},metric:rdps,timeframe:Historical)`
  )).join("\n");
  const ch = (await gql(`query($n:String!,$s:String!){characterData{character(name:$n,serverSlug:$s,serverRegion:"CN"){ ${alias} }}}`,
    { n: name, s: server })).characterData?.character || {};

  const rows = [];
  const needScan = [];
  let wantWeekly = false;
  for (const g of glist) {
    let killed = false, firstMs = null, firstRank = null, specCount = {};
    for (const eid of g.eids) {
      const er = ch["e" + eid];
      if (!er) continue;
      if ((er.totalKills || 0) > 0) killed = true;
      for (const r of er.ranks || []) {
        if (r.startTime != null && (firstMs == null || r.startTime < firstMs)) { firstMs = r.startTime; firstRank = r; }
        const sp = r.spec || r.bestSpec;
        if (sp) specCount[sp] = (specCount[sp] || 0) + 1;
      }
    }
    if (killed) {
      wantWeekly = true;
      rows.push({
        group: g.name, cleared: true, firstMs,
        firstLink: firstRank?.report?.code ? `${config.base}/reports/${firstRank.report.code}#fight=${firstRank.report.fightID}` : null,
        job: Object.entries(specCount).sort((a, b) => b[1] - a[1])[0]?.[0],
      });
    } else {
      needScan.push(g);
    }
  }

  // ② 拉报告列表：未通关要最近 40 份；已通关要覆盖最近一周
  const targetZones = new Set(glist.flatMap(g => [...g.zones]));
  const cutoff = Date.now() - WEEK_MS;
  const list = await characterReports(name, server, {
    zones: targetZones,
    need: needScan.length ? 40 : 1,
    untilTs: wantWeekly ? cutoff : null,
  });
  if (list == null) return { rows: [], notFound: true };

  const zoneRows = list.filter(r => targetZones.has(r.zone)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const scanSet = new Map();
  if (needScan.length) for (const r of zoneRows.slice(0, 40)) scanSet.set(r.code, r);
  if (wantWeekly) for (const r of zoneRows) if ((r.ts || 0) >= cutoff) scanSet.set(r.code, r);

  const partials = scanSet.size
    ? await scanReports([...scanSet.values()], norm(name), norm(server), await encMeta().then(m => m.meta))
    : [];

  const eidToGroup = {};
  for (const g of glist) for (const eid of g.eids) eidToGroup[eid] = g.name;
  const bestAll = {}, bestWeek = {};
  for (const p of partials) for (const [eid, cand] of Object.entries(p)) {
    const gname = eidToGroup[eid];
    if (!gname) continue;
    if (!bestAll[gname] || rankLess(cand.rank, bestAll[gname].rank)) bestAll[gname] = cand;
    if (cand.timeMs >= cutoff && (!bestWeek[gname] || rankLess(cand.rank, bestWeek[gname].rank))) bestWeek[gname] = cand;
  }

  for (const g of needScan) rows.push({ group: g.name, cleared: false, pull: bestAll[g.name] || null });
  for (const row of rows) if (row.cleared) row.weekPull = bestWeek[row.group] || null;

  rows.sort((a, b) => (a.cleared ? 0 : 1) - (b.cleared ? 0 : 1) || ((a.pull?.fp ?? 999) - (b.pull?.fp ?? 999)));
  return { rows };
}

/* ============ UI ============ */
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
let currentZone = ZONE_TABS[0].id;   // 默认最新绝本
let currentChar = null; // {name, server}

function renderChips() {
  const box = $("#chips");
  box.innerHTML = "";
  for (const z of ZONE_TABS) {
    const c = el("button", "chip" + (currentZone === z.id ? " on" : ""), z.label);
    // 只改变选择，不触发查询——查询由「查询」按钮/回车/建议点击发起，已出的结果不动
    c.onclick = () => { currentZone = z.id; renderChips(); };
    box.appendChild(c);
  }
}

function memberChip(p) {
  const d = el("div", `member ${roleOf(p.job)}` + (p.me ? " me" : ""));
  const img = el("img");
  img.src = `icons/${p.job}.png`;
  img.alt = p.job || "";
  img.title = JOB_ZH[p.job] || p.job || "";
  img.onerror = () => img.remove();
  d.appendChild(img);
  const n = el("span", "mn");
  n.appendChild(el("span", "mname", p.name || "?"));
  if (p.server) n.appendChild(el("span", "ms", "@" + p.server));
  d.appendChild(n);
  return d;
}

function pullCard(title, pull, statusText, statusCls, extraWhen) {
  const card = el("div", "card");
  const line = el("div", "bossline");
  line.appendChild(el("span", "boss", title));
  line.appendChild(el("span", "status " + statusCls, statusText));
  const whenParts = [];
  if (pull?.job && JOB_ZH[pull.job]) whenParts.push(JOB_ZH[pull.job]);
  if (pull?.timeMs) whenParts.push(fmtCST(pull.timeMs));
  if (extraWhen) whenParts.push(extraWhen);
  if (whenParts.length) line.appendChild(el("span", "when", whenParts.join(" · ")));
  if (pull?.code) {
    const a = el("a", "logLink", "查看 log ↗");
    a.href = `${config.base}/reports/${pull.code}#fight=${pull.fightId}`;
    a.target = "_blank"; a.rel = "noopener";
    line.appendChild(a);
  }
  card.appendChild(line);
  if (pull?.party?.length) {
    const box = el("div", "party");
    pull.party.forEach(p => box.appendChild(memberChip(p)));
    card.appendChild(box);
  }
  return card;
}

function progressText(pull) {
  const p = pull.phase ? `P${pull.phase}` : "未知阶段";
  const hp = pull.hp == null ? "未知" : pull.hp + "%";
  return pull.cleared ? "击杀" : `最远 ${p}（boss 剩 ${hp}）`;
}

async function updatePoints() {
  try {
    const d = await gql("{rateLimitData{ pointsSpentThisHour limitPerHour }}");
    const r = d.rateLimitData;
    if (r) $("#points").textContent = `本小时已用 ${Math.round(r.pointsSpentThisHour)} / ${r.limitPerHour} 点`;
  } catch { /* 点数显示是装饰，失败不打扰 */ }
}

function showMsg(text, isErr) {
  const box = $("#result");
  box.innerHTML = "";
  box.appendChild(el("div", "msg" + (isErr ? " err" : ""), text));
}

function pushHistory(name, server) {
  history = [{ name, server, ts: Date.now() },
    ...history.filter(h => !(h.name === name && h.server === server))].slice(0, 20);
  LS.set("fpw_history", history);
}

async function runQuery() {
  const raw = $("#q").value.trim();
  if (!raw && !currentChar) return;
  $("#sugg").classList.add("hidden");
  const box = $("#result");
  box.innerHTML = "";
  box.appendChild(el("div", "spin", "查询中"));

  try {
    let name, server, note = null;
    if (currentChar && !raw) ({ name, server } = currentChar);
    else {
      const [n, s] = raw.includes("@") ? raw.split("@", 2) : [raw, ""];
      const r = await resolveCharacter(n.trim(), s.trim());
      if (!r.name) {
        showMsg(s
          ? `FFLogs 上没找到角色「${n}@${s}」。\n确认服务器名和写法（黒/黑 已自动多试）；也可以只输入角色名全服自动找。\n查不到 ≠ 没打 —— 可能没传过 log。`
          : `全国服都没搜到叫「${n}」且传过 log 的角色。\n确认名字写法；「没找到 ≠ 没打」——可能没传过 log，或传到了国际服站。`);
        return;
      }
      ({ name, server } = r); note = r.note;
      currentChar = { name, server };
      pushHistory(name, server);
      $("#q").value = `${name}@${server}`;
    }

    box.innerHTML = "";
    const head = el("div", "charHead");
    head.appendChild(el("span", "who", `${name} @ ${server}`));
    head.appendChild(el("span", "meta", ZONE_TABS.find(z => z.id === currentZone)?.label || ""));
    box.appendChild(head);
    if (note) box.appendChild(el("div", "notice", "⚠ " + note));
    box.appendChild(el("div", "spin", "查询中"));

    // 15 分钟内同角色同副本直接复用上次结果（零请求）
    const lk = `${norm(name + "@" + server)}|${currentZone}`;
    const lastHit = cache.last[lk];
    let res;
    if (lastHit && Date.now() - lastHit.ts < LAST_TTL) res = lastHit.v;
    else {
      res = await zoneProgress(name, server, currentZone);
      cache.last[lk] = { ts: Date.now(), v: res };
    }
    const { rows, notFound } = res;
    box.querySelector(".spin").remove();
    if (notFound || !rows.length) {
      box.appendChild(el("div", "msg", "FFLogs 上没查到这个副本的记录。查不到不等于没打——可能没传过 log。"));
    }
    for (const row of rows) {
      if (!row.cleared) {
        if (row.pull) box.appendChild(pullCard(row.group, row.pull, progressText(row.pull), "prog"));
        else box.appendChild(pullCard(row.group, null, "无记录", "prog"));
      } else if (row.weekPull) {
        box.appendChild(pullCard(row.group, row.weekPull,
          "已通关 · 本周" + (row.weekPull.cleared ? "击杀" : " " + progressText(row.weekPull)), "clear"));
      } else {
        const card = pullCard(row.group, null,
          "已通关 · 本周无记录", "clear",
          row.firstMs ? `首通 ${fmtCST(row.firstMs, true)}` + (JOB_ZH[row.job] ? `（${JOB_ZH[row.job]}）` : "") : null);
        if (row.firstLink) {
          const a = el("a", "logLink", "首通 log ↗");
          a.href = row.firstLink; a.target = "_blank"; a.rel = "noopener";
          card.querySelector(".bossline").appendChild(a);
        }
        box.appendChild(card);
      }
    }
    updatePoints();
  } catch (e) {
    if (e instanceof FFLogsError && e.message === "NEED_CONFIG") {
      showMsg("还没有配置 FFLogs API —— 点右上角「API 设置」，两分钟搞定。", true);
      $("#settings").showModal();
    } else {
      showMsg((e instanceof FFLogsError ? "" : "出错了：") + e.message, true);
    }
  } finally {
    saveCache();
  }
}

/* ---- 搜索建议：本地历史即时 + 完整名停顿探测 ---- */
let probeTimer = null, probeSeq = 0;
function renderSugg(items) {
  const box = $("#sugg");
  box.innerHTML = "";
  if (!items.length) { box.classList.add("hidden"); return; }
  items.forEach(it => {
    const d = el("div", "item" + (it.dim ? " dim" : ""));
    if (it.dim) d.textContent = it.text;
    else {
      d.appendChild(el("span", "n", it.name));
      d.appendChild(el("span", "s", "CN - " + it.server + (it.when ? ` · ${it.when}` : "")));
      d.onmousedown = e => {   // mousedown 抢在 blur 前
        e.preventDefault();
        $("#q").value = `${it.name}@${it.server}`;
        currentChar = null;
        runQuery();
      };
    }
    box.appendChild(d);
  });
  box.classList.remove("hidden");
}

function onInput() {
  const v = $("#q").value.trim();
  currentChar = null;
  clearTimeout(probeTimer);
  probeSeq++;
  if (!v || v.includes("@")) { renderSugg([]); return; }
  const nv = norm(v);
  const local = history.filter(h => norm(h.name).startsWith(nv))
    .map(h => ({ name: h.name, server: h.server }));
  renderSugg(local);
  if (v.length < 2 || !config.clientId) return;
  const seq = probeSeq;
  probeTimer = setTimeout(async () => {
    renderSugg([...local, { dim: true, text: "全服搜索中…" }]);
    try {
      const r = await searchCharacter(v);
      if (seq !== probeSeq) return;   // 输入已变，丢弃
      const remote = (r.hits || []).filter(h => h.lastTs > 0)
        .map(h => ({ name: h.name, server: h.server, when: h.lastTs ? fmtCST(h.lastTs).slice(0, 5) : "" }))
        .filter(h => !local.some(l => l.name === h.name && l.server === h.server));
      renderSugg([...local, ...remote]);
      saveCache();
    } catch {
      if (seq === probeSeq) renderSugg(local);
    }
  }, 600);
}

/* ---- 设置 ---- */
function openSettings() {
  $("#cfgId").value = config.clientId;
  $("#cfgSecret").value = config.clientSecret;
  $("#cfgBase").value = config.base;
  $("#settings").showModal();
}
$("#settings").addEventListener("close", () => {
  if ($("#settings").returnValue !== "save") return;
  config = {
    clientId: $("#cfgId").value.trim(),
    clientSecret: $("#cfgSecret").value.trim(),
    base: ($("#cfgBase").value.trim() || "https://cn.fflogs.com").replace(/\/+$/, ""),
  };
  LS.set("fpw_config", config);
  localStorage.removeItem("fpw_token");
  updatePoints();
});

/* ---- 绑定 ---- */
$("#settingsBtn").onclick = openSettings;
$("#go").onclick = () => { currentChar = null; runQuery(); };
$("#q").addEventListener("input", onInput);
$("#q").addEventListener("keydown", e => { if (e.isComposing) return; if (e.key === "Enter") { currentChar = null; runQuery(); } });
$("#q").addEventListener("blur", () => setTimeout(() => $("#sugg").classList.add("hidden"), 150));
renderChips();
if (!config.clientId) openSettings();
else updatePoints();
