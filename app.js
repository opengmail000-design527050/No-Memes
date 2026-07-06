/* No进度欺诈 web 版 —— progress_query.py 的浏览器移植。
 * 纯静态、查询直连 cn.fflogs.com（CORS 已验证）。鉴权双模式：
 *   A. FF Logs 账号登录（OAuth 授权码 + PKCE，公共客户端无 secret）→ /api/v2/user，点数各算各的
 *   B. 用户自带 client 凭据（高级设置，localStorage）→ /api/v2/client
 * 优先 A，A 的 token 失效且存有 B 凭据时自动降级重试一次。 */
"use strict";

/* ============ 常量（来自 fflogs_query.py） ============ */
const ULT_ZONES = [19, 23, 32, 45, 53, 65, 76, 30, 43, 59]; // 含旧绝本 grouping zone
const IMMUTABLE_MS = 48 * 3600 * 1000;   // 报告开播 48h 后视为不可变
const DAY_MS = 86400 * 1000;
const WEEK_MS = 7 * DAY_MS;
const CST_OFFSET_MS = 8 * 3600 * 1000;
const REPORT_SCAN_GRACE_MS = 12 * 3600 * 1000; // 覆盖跨 7 天边界的长报告
const LAST_TTL = 60 * 60 * 1000;         // 同角色同副本 1 小时内复用结果（40 秒 stamp 探测兜底新报告，见 canUseLastHit）
const REPORT_PROBE_TTL = 40 * 1000;      // 命中结果缓存时，最多 40 秒探测一次新上传报告
const BATCH = 10;                        // 报告扫描别名批量大小（实测点数最优）

// 副本选择（只绝本，FF Logs 国服完整名，新→旧）
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
  const d = new Date(ms + CST_OFFSET_MS);  // CST = UTC+8，用 UTC getter 定格
  const md = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return full ? `${d.getUTCFullYear()}-${md}` : md;
}
function cstDayStart(ms) {
  return Math.floor((ms + CST_OFFSET_MS) / DAY_MS) * DAY_MS - CST_OFFSET_MS;
}
function cstDayLabel(dayStart) {
  const d = new Date(dayStart + CST_OFFSET_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
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
for (const k of ["scans", "reports", "resolve", "servers", "last", "cleared"]) cache[k] ??= {};
if (cache.v !== 5) { cache.scans = {}; cache.last = {}; cache.cleared = {}; cache.v = 5; }
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

/* ============ FF Logs 客户端 ============ */
class FFLogsError extends Error {}

// 站长在 cn.fflogs.com/api/clients 创建 Public Client（勾 Public、无 secret，
// Redirect URL 填部署地址如 https://no-memes.pages.dev/）后，把 Client ID 填到这里。
// 留空 = 登录功能不启用，只剩高级（自带凭据）模式。
const OAUTH_CLIENT_ID = "a22c87a7-8f6f-4277-9707-7a277e56b946";
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, "");

let userAuth = LS.get("fpw_user", null);   // { token, refresh, exp, base, name }

function saveUser(u) {
  userAuth = u;
  if (u) LS.set("fpw_user", u); else localStorage.removeItem("fpw_user");
  renderAuthUI();
}

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randTok = () => b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);

async function oauthToken(params) {
  const r = await fetch(config.base + "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, ...params }),
  });
  if (!r.ok) throw new FFLogsError(`FF Logs 授权失败（HTTP ${r.status}）`);
  return r.json();
}

async function login() {
  if (!crypto.subtle) { showMsg("登录需要 https 或 localhost 环境。", true); $("#settings").close(); return; }
  const verifier = randTok(), state = randTok();
  sessionStorage.setItem("fpw_pkce", JSON.stringify({ verifier, state }));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  location.href = config.base + "/oauth/authorize?" + new URLSearchParams({
    client_id: OAUTH_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", state,
  });
}

// 授权回跳：换 token → 抹掉地址栏里的 code → 拉用户名/角色
async function handleOAuthCallback() {
  const q = new URLSearchParams(location.search);
  if (!q.get("code") && !q.get("error")) return;
  window.history.replaceState(null, "", location.pathname);   // history 变量被本文件遮蔽，须走 window
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem("fpw_pkce") || "null"); } catch {}
  sessionStorage.removeItem("fpw_pkce");
  if (q.get("error")) { showMsg(`FF Logs 授权未完成（${q.get("error")}）。`, true); return; }
  if (!saved || saved.state !== q.get("state")) { showMsg("登录校验失败（state 不匹配），请重新登录。", true); return; }
  try {
    const p = await oauthToken({
      grant_type: "authorization_code", redirect_uri: REDIRECT_URI,
      code: q.get("code"), code_verifier: saved.verifier,
    });
    saveUser({ token: p.access_token, refresh: p.refresh_token || null, exp: Date.now() + (p.expires_in || 3600) * 1000, base: config.base, name: null });
    await fetchUserInfo();
  } catch (e) {
    showMsg("FF Logs 登录失败：" + e.message, true);
  }
}

// 用户名 + 名下认领的角色（角色喂进搜索历史，输入框一点就有）；schema 不支持 characters 时退回只拿名字
async function fetchUserInfo() {
  let cu = null;
  try { cu = (await gql("{userData{currentUser{ name characters{ name server{ name } }}}}")).userData?.currentUser; }
  catch { try { cu = (await gql("{userData{currentUser{ name }}}")).userData?.currentUser; } catch {} }
  if (!cu) return;
  saveUser({ ...userAuth, name: cu.name || null });
  for (const c of (cu.characters || []).slice(0, 8)) {
    if (!c?.name || !c.server?.name) continue;
    if (!history.some(h => h.name === c.name && h.server === c.server.name))
      history.push({ name: c.name, server: c.server.name, ts: 0 });
  }
  history = history.slice(0, 20);
  LS.set("fpw_history", history);
}

const hasAuth = () => !!(userAuth && userAuth.base === config.base) || !!(config.clientId && config.clientSecret);

// 鉴权解析：登录 token 优先（过期先试续期），否则自带凭据，都没有才要求配置
let refreshing = null;   // 并发查询共享一次续期：refresh token 会轮换，重复提交会互相打架
async function ensureAuth() {
  if (userAuth && userAuth.base === config.base) {
    if (Date.now() < userAuth.exp - 60000) return { token: userAuth.token, ep: "/api/v2/user", user: true };
    if (userAuth.refresh) {
      try {
        refreshing ??= oauthToken({ grant_type: "refresh_token", refresh_token: userAuth.refresh })
          .then(p => saveUser({ ...userAuth, token: p.access_token, refresh: p.refresh_token || userAuth.refresh, exp: Date.now() + (p.expires_in || 3600) * 1000 }))
          .finally(() => { refreshing = null; });
        await refreshing;
        if (userAuth) return { token: userAuth.token, ep: "/api/v2/user", user: true };
      } catch { saveUser(null); }   // 续期失败：清登录态，落回自带凭据/引导
    } else saveUser(null);
  }
  const t = LS.get("fpw_token", null);
  if (t && t.base === config.base && t.id === config.clientId && Date.now() < t.exp - 60000)
    return { token: t.token, ep: "/api/v2/client", user: false };
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
  return { token: p.access_token, ep: "/api/v2/client", user: false };
}

async function gql(query, variables) {
  for (let retried = false; ;) {
    const auth = await ensureAuth();
    const r = await fetch(config.base + auth.ep, {
      method: "POST",
      headers: { Authorization: "Bearer " + auth.token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    if (r.status === 401) {
      if (auth.user) {
        saveUser(null);
        if (!retried && config.clientId && config.clientSecret) { retried = true; continue; }   // 登录过期 → 降级自带凭据重试一次
        throw new FFLogsError("NEED_LOGIN");
      }
      localStorage.removeItem("fpw_token");
      throw new FFLogsError("凭据失效，请重新保存 API 设置");
    }
    if (r.status === 429) throw new FFLogsError(auth.user ? "FF Logs 限流（你的账号本小时点数用完），稍后再试" : "FF Logs 限流（本小时点数用完），稍后再试");
    if (!r.ok) throw new FFLogsError(`FF Logs 请求失败（HTTP ${r.status}）`);
    const data = await r.json();
    // 批量别名查询（31 服探测等）里个别字段出错（如隐藏角色）不拖垮整次请求：有部分数据就用部分数据
    if (data.errors && !data.data) throw new FFLogsError("GraphQL: " + data.errors.map(e => e.message).join("; "));
    return data.data || {};
  }
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
  if (rid == null) throw new FFLogsError("FF Logs 上没有 CN 大区");
  const d = await gql("query($id:Int!){worldData{region(id:$id){subregions{servers(limit:100){data{name}}}}}}", { id: rid });
  const names = (d.worldData?.region?.subregions || []).flatMap(s => (s.servers?.data || []).map(x => x.name));
  if (names.length) cache.servers.CN = { ts: Date.now(), v: names };
  return names;
}

// 31 服探测缓存：建议列表和回车正式查询会对同一个名字各打一轮（~2 点/轮），10 分钟内直接复用
const probeCache = new Map();   // ponytail: 只存内存不落盘，跨会话复用价值低
const PROBE_CACHE_TTL = 10 * 60 * 1000;

async function probeServers(name, servers) {
  const pc = probeCache.get(name);
  if (pc && Date.now() - pc.ts < PROBE_CACHE_TTL) return pc.hits;
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
  probeCache.set(name, { ts: Date.now(), hits });   // 查无此人也缓存，重试同名不再烧点
  return hits;
}

// maxCands：建议列表打一半时名字多半不完整，异体字候选全试必然全落空白烧点，只试原始拼写
async function searchCharacter(name, maxCands = 4) {
  const servers = await cnServers();
  const cands = nameCandidates(name);
  const normset = new Set(cands.map(norm));
  let hits = [], anyOk = false, lastErr = null;
  for (const cand of cands.slice(0, maxCands)) {
    try { hits = await probeServers(cand, servers); } catch (e) { lastErr = e; continue; }
    anyOk = true;
    if (hits.length) break;
  }
  if (!anyOk && lastErr) throw lastErr;
  const active = hits.filter(h => h.lastTs > 0);   // 没传过 log 的没进度可查
  if (!active.length) return { hits: hits };
  // 名字精确命中优先（FF Logs 会把改过名的老角色也匹配出来），再按最近上传排
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
  // 异体字候选合并成一个别名批量查询（原来逐个单发，最多 16 次请求）
  const cands = nameCandidates(name).slice(0, 8);
  const alias = cands.map((c, i) =>
    `c${i}: character(name:${JSON.stringify(c)},serverSlug:${JSON.stringify(server)},serverRegion:"CN"){ name server{ name } }`
  ).join("\n");
  const cd = (await gql(`query{ characterData{ ${alias} }}`)).characterData || {};
  for (let i = 0; i < cands.length; i++) {
    const ch = cd["c" + i];
    if (ch) {
      const v = [ch.name, ch.server?.name || server];
      cache.resolve[ck] = { ts: Date.now(), v };
      return { name: v[0], server: v[1], note: null };
    }
  }
  return { name: null };
}

/* ============ 报告列表 + 扫描（含缓存/批量，同 Python 版三刀） ============ */
const REPORT_FIELDS = `startTime
  masterData{ actors(type:"Player"){ id name server subType } }
  fights{ id encounterID name kill fightPercentage bossPercentage lastPhase startTime endTime friendlyPlayers }`;

function parseReport(rep, code, wname, wserver, meta) {
  const base = rep.startTime || 0;
  const actors = rep.masterData?.actors || [];
  const actorMap = new Map(actors.map(a => [a.id, a]));
  const myIds = new Set(actors.filter(a =>
    norm(a.name) === wname && (!a.server || norm(a.server) === wserver)).map(a => a.id));
  if (!myIds.size) return {};
  const out = {};
  const pullsByEid = {};
  for (const f of rep.fights || []) {
    const eid = f.encounterID;
    if (!eid) continue;
    const fp = f.friendlyPlayers || [];
    const mine = fp.filter(id => myIds.has(id));
    if (!mine.length) continue;                    // 本人没上这把（社区聚合报告过滤，关键）
    const startMs = base + (f.startTime || 0);
    const endMs = base + (f.endTime ?? f.startTime ?? 0);
    if (endMs > startMs) {
      (pullsByEid[eid] ??= []).push({
        eid, startMs, endMs, durationMs: endMs - startMs,
        kill: !!f.kill, phase: f.lastPhase,
        code, fightId: f.id,
      });
    }
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
      timeMs: startMs,
      endMs,
      durationMs: endMs - startMs,
      code, fightId: f.id,
      job: actorMap.get(mine[0])?.subType,
      party,
    };
  }
  for (const [eid, pulls] of Object.entries(pullsByEid)) if (out[eid]) out[eid].pulls = pulls;
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

const latestReportStamp = rows => {
  const r = rows[0];
  return r ? `${r.code}|${r.ts || 0}` : "";
};

async function probeLatestReportStamp(name, server, zoneId) {
  const { groups } = await encMeta();
  const glist = groups.filter(g => g.zones.has(zoneId));
  const targetZones = new Set(glist.flatMap(g => [...g.zones]));
  if (!targetZones.size) return null;
  const Q = `query($n:String!,$s:String!){
    characterData{ character(name:$n,serverSlug:$s,serverRegion:"CN"){
      recentReports(limit:10){ data{ code startTime zone{ id } } }}}}`;
  const ch = (await gql(Q, { n: name, s: server })).characterData?.character;
  const rows = (ch?.recentReports?.data || [])
    .map(x => ({ code: x.code, zone: x.zone?.id, ts: x.startTime }))
    .filter(r => targetZones.has(r.zone))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return rows.length ? latestReportStamp(rows) : null;
}

async function canUseLastHit(lastHit, name, server, zoneId) {
  if (!lastHit || Date.now() - lastHit.ts >= LAST_TTL) return false;
  if (Date.now() - (lastHit.probeTs || 0) < REPORT_PROBE_TTL) return true;
  try {
    const stamp = await probeLatestReportStamp(name, server, zoneId);
    lastHit.probeTs = Date.now();
    return stamp == null || (lastHit.v.reportStamp != null && stamp === lastHit.v.reportStamp);
  } catch {
    lastHit.probeTs = Date.now();
    return true;
  }
}

/* ============ 查询编排 ============ */
// 先判通关；通关→最近一周最远那把；未通关→扫最近 40 份找最远
async function zoneProgress(name, server, zoneId) {
  const { groups } = await encMeta();
  const glist = groups.filter(g => g.zones.has(zoneId));
  if (!glist.length) throw new FFLogsError("这个副本没有 encounter 数据");

  // ① 通关判定：通关是不可逆的历史事实（首通时间/链接/职业定格），确认过一次就永久缓存，
  //    只对还没确认通关的 boss 发 encounterRankings；全通角色这一步零请求
  const clearKey = norm(`${name}@${server}`) + "|CN";
  const known = cache.cleared[clearKey] ??= {};
  const rows = glist.filter(g => known[g.name]).map(g => ({ ...known[g.name] }));
  const needScan = [];
  const unknown = glist.filter(g => !known[g.name]);
  if (unknown.length) {
    const alias = unknown.flatMap(g => g.eids.map(eid =>
      `e${eid}: encounterRankings(encounterID:${eid},metric:rdps,timeframe:Historical)`
    )).join("\n");
    const ch = (await gql(`query($n:String!,$s:String!){characterData{character(name:$n,serverSlug:$s,serverRegion:"CN"){ ${alias} }}}`,
      { n: name, s: server })).characterData?.character || {};

    for (const g of unknown) {
      let killed = false, firstStart = null, firstMs = null, firstRank = null, specCount = {};
      for (const eid of g.eids) {
        const er = ch["e" + eid];
        if (!er) continue;
        if ((er.totalKills || 0) > 0) killed = true;
        for (const r of er.ranks || []) {
          // 取最早开打的那把（首通），但记它的击杀时刻=开打+时长，和"最近通关"用 endMs 同口径
          if (r.startTime != null && (firstStart == null || r.startTime < firstStart)) {
            firstStart = r.startTime;
            firstMs = r.startTime + (r.duration || 0);
            firstRank = r;
          }
          const sp = r.spec || r.bestSpec;
          if (sp) specCount[sp] = (specCount[sp] || 0) + 1;
        }
      }
      if (killed) {
        const row = {
          group: g.name, cleared: true, firstMs,
          firstLink: firstRank?.report?.code ? `${config.base}/reports/${firstRank.report.code}#fight=${firstRank.report.fightID}` : null,
          job: Object.entries(specCount).sort((a, b) => b[1] - a[1])[0]?.[0],
        };
        known[g.name] = row;
        rows.push({ ...row });   // 副本给渲染层挂周数据用，缓存里只留定格字段
      } else {
        needScan.push(g);
      }
    }
  }

  // ② 拉报告列表：未通关要最近 40 份；已通关要覆盖最近一周
  const targetZones = new Set(glist.flatMap(g => [...g.zones]));
  const now = Date.now();
  const cutoff = now - WEEK_MS;
  const scanCutoff = cutoff - REPORT_SCAN_GRACE_MS;
  const list = await characterReports(name, server, {
    zones: targetZones,
    need: needScan.length ? 40 : 1,
    untilTs: scanCutoff,
  });
  if (list == null) return { rows: [], notFound: true, reportStamp: "" };

  const zoneRows = list.filter(r => targetZones.has(r.zone)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const reportStamp = latestReportStamp(zoneRows);
  const scanSet = new Map();
  if (needScan.length) for (const r of zoneRows.slice(0, 40)) scanSet.set(r.code, r);
  for (const r of zoneRows) if ((r.ts || 0) >= scanCutoff) scanSet.set(r.code, r);

  const partials = scanSet.size
    ? await scanReports([...scanSet.values()], norm(name), norm(server), await encMeta().then(m => m.meta))
    : [];

  const eidToGroup = {};
  for (const g of glist) for (const eid of g.eids) eidToGroup[eid] = g.name;
  const bestAll = {}, bestWeek = {}, weekPulls = {}, lastKill = {};
  for (const p of partials) for (const [eid, cand] of Object.entries(p)) {
    const gname = eidToGroup[eid];
    if (!gname) continue;
    if (!bestAll[gname] || rankLess(cand.rank, bestAll[gname].rank)) bestAll[gname] = cand;
    if ((cand.endMs || cand.timeMs) >= cutoff) {
      if (!bestWeek[gname] || rankLess(cand.rank, bestWeek[gname].rank)) bestWeek[gname] = cand;
      if (cand.cleared && (!lastKill[gname] || cand.endMs > lastKill[gname].endMs)) lastKill[gname] = cand;
    }
    for (const pull of cand.pulls || []) {
      if (pull.endMs >= cutoff) (weekPulls[gname] ??= []).push(pull);
    }
  }

  const weekStats = {};
  for (const g of glist) weekStats[g.name] = buildWeekStat(dedupePulls(weekPulls[g.name] || []), now);

  for (const g of needScan) rows.push({ group: g.name, cleared: false, pull: bestAll[g.name] || null, weekStat: weekStats[g.name] });
  for (const row of rows) if (row.cleared) {
    row.weekPull = bestWeek[row.group] || null;
    row.weekKill = lastKill[row.group] || null;   // 近7天最新的那把通关（带小队/职业/log 链接）
    row.weekStat = weekStats[row.group];
  }

  rows.sort((a, b) => (a.cleared ? 0 : 1) - (b.cleared ? 0 : 1) || ((a.pull?.fp ?? 999) - (b.pull?.fp ?? 999)));
  return { rows, reportStamp };
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

function pullCard(title, pull, statusText, statusCls, extraWhen, weekStat) {
  const card = el("div", "card");
  const line = el("div", "bossline");
  line.appendChild(el("span", "boss", title));
  // 进度类只刷主文案；近7天真实击杀保留“最近通关 · 职业 · 时间”整条笔刷。
  const parts = [statusText];
  const whenParts = [];
  const metaParts = pull?.cleared && statusCls === "clear" ? parts : whenParts;
  if (pull?.job && JOB_ZH[pull.job]) metaParts.push(JOB_ZH[pull.job]);
  if (pull?.timeMs) metaParts.push(fmtCST(pull.timeMs));
  const badge = el("span", "status " + statusCls);
  badge.appendChild(brushStroke(pull?.timeMs || 1, statusCls === "clear" ? null : "--brush-orange"));
  badge.appendChild(el("span", "badgeTxt", parts.join(" · ")));
  line.appendChild(badge);
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
  if (weekStat) card.appendChild(weeklyChart(weekStat));
  return card;
}

/* 头部徽章的笔刷底:上下平行、微微错开的两笔半透明水彩(交叠处自然加深),
   viewBox 拉伸铺满徽章,随文字长短自适应 */
function brushStroke(seed, brush) {
  const prefix = brush || "--brush-green";
  const rnd = seededRand(seed);
  const svg = svgEl("svg", { class: "badgeBrush", viewBox: "0 0 120 30", preserveAspectRatio: "none", "aria-hidden": "true" });
  svgEl("path", { d: wobPath(barPts(2, 3, 110, 16, 7, 6), 2.4, true, rnd), fill: `var(${prefix}-1)`, transform: "rotate(-.6 57 11)" }, svg);
  svgEl("path", { d: wobPath(barPts(8, 12, 108, 15, 6, 5), 2.6, true, rnd), fill: `var(${prefix}-2)`, transform: "rotate(.8 62 20)" }, svg);
  return svg;
}

// ID 右边的「已通关 · 职业 · 首通日期」徽章,点击跳首通 log
function clearBadge(row) {
  const a = el("a", "clearBadge");
  if (row.firstLink) { a.href = row.firstLink; a.target = "_blank"; a.rel = "noopener"; }
  let date = null;
  if (row.firstMs) {
    const y = new Date(row.firstMs + CST_OFFSET_MS).getUTCFullYear();
    const md = fmtCST(row.firstMs).slice(0, 5);
    date = y === new Date(Date.now() + CST_OFFSET_MS).getUTCFullYear() ? md : `${y}-${md}`;
  }
  a.appendChild(brushStroke(row.firstMs || 1));
  a.appendChild(el("span", "badgeTxt", ["已通关", JOB_ZH[row.job], date].filter(Boolean).join(" · ")));
  return a;
}

function progressText(pull) {
  const p = pull.phase ? `P${pull.phase}` : "未知阶段";
  const hp = pull.hp == null ? "未知" : pull.hp + "%";
  return pull.cleared ? "击杀" : `最远 ${p}（boss 剩 ${hp}）`;
}

function dedupePulls(pulls) {
  const out = [];
  for (const p of pulls.sort((a, b) => a.startMs - b.startMs)) {
    if (out.some(q => q.eid === p.eid
      && Math.abs(q.durationMs - p.durationMs) <= 2000
      && Math.abs(q.startMs - p.startMs) <= 5 * 60000)) continue;
    out.push(p);
  }
  return out;
}

function buildWeekStat(pulls, now) {
  const today = cstDayStart(now);
  const days = Array.from({ length: 7 }, (_, i) => {
    const start = today - (6 - i) * DAY_MS;
    return { key: start, label: cstDayLabel(start), pulls: 0, ms: 0, wipes: {} };
  });
  const byDay = new Map(days.map(d => [d.key, d]));
  for (const p of pulls) {
    const day = byDay.get(cstDayStart(p.endMs));
    if (!day) continue;
    day.pulls++;
    day.ms += p.durationMs;
    if (!p.kill && p.phase != null) day.wipes[p.phase] = (day.wipes[p.phase] || 0) + 1;
  }
  const wipes = {};
  for (const d of days) for (const [ph, n] of Object.entries(d.wipes)) wipes[ph] = (wipes[ph] || 0) + n;
  return {
    pulls: days.reduce((n, d) => n + d.pulls, 0),
    kills: pulls.filter(p => p.kill).length,
    ms: days.reduce((n, d) => n + d.ms, 0),
    wipes,
    days,
  };
}

function durationText(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} 分钟`;
  const hours = mins / 60;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} 小时`;
}

function phaseEntries(wipes, limit) {
  const entries = Object.entries(wipes || {}).filter(([, n]) => n > 0);
  if (limit && entries.length > limit) {
    return entries.sort((a, b) => b[1] - a[1]).slice(0, limit).sort((a, b) => a[0] - b[0]);
  }
  return entries.sort((a, b) => a[0] - b[0]);
}

function phaseText(wipes, limit) {
  const entries = phaseEntries(wipes, limit);
  return entries.length ? entries.map(([p, n]) => `P${p}×${n}`).join(" · ") : "无灭点记录";
}

/* —— 手绘工具:种子随机 + 平滑抖动路径(贝塞尔过中点,无棱角) —— */
function seededRand(seed) {
  let s = Math.floor(Math.abs(seed)) % 2147483647 || 1;
  return () => (s = s * 16807 % 2147483647) / 2147483647 * 2 - 1;
}

function wobPath(pts, amp, close, rnd) {
  const s = [];
  const edges = pts.length - (close ? 0 : 1);
  for (let i = 0; i < edges; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 16));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      s.push([a[0] + (b[0] - a[0]) * t + (i || k ? rnd() * amp : 0),
              a[1] + (b[1] - a[1]) * t + (i || k ? rnd() * amp : 0)]);
    }
  }
  if (!close) s.push(pts[pts.length - 1]);
  const f = v => v.toFixed(1);
  const mid = (p, q) => f((p[0] + q[0]) / 2) + "," + f((p[1] + q[1]) / 2);
  let d;
  if (close) {
    d = "M" + mid(s[s.length - 1], s[0]);
    s.forEach((p, i) => { d += "Q" + f(p[0]) + "," + f(p[1]) + " " + mid(p, s[(i + 1) % s.length]); });
    return d + "Z";
  }
  d = "M" + f(s[0][0]) + "," + f(s[0][1]);
  for (let i = 1; i < s.length - 1; i++) d += "Q" + f(s[i][0]) + "," + f(s[i][1]) + " " + mid(s[i], s[i + 1]);
  return d + "L" + f(s[s.length - 1][0]) + "," + f(s[s.length - 1][1]);
}

/* 上圆下方的八边形轮廓,切角经抖动+曲线自然磨圆 */
function barPts(x, y, w, h, tc, bc) {
  return [[x, y + tc], [x + tc, y], [x + w - tc, y], [x + w, y + tc],
          [x + w, y + h - bc], [x + w - bc, y + h], [x + bc, y + h], [x, y + h - bc]];
}

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

/* 比例分段的灭点色带:段长∝次数,颜色按在场 P 数从浅到深自适应。
   数字全部写在色带下方当轴注记(块内无字);和左邻打架的注记降一行用引线避让 */
function wipeStrip(entries, W, H, rnd) {
  const total = entries.reduce((n, [, c]) => n + c, 0);
  const k = entries.length;
  const gap = 4;
  const usable = W - 2 - gap * (k - 1);
  const segs = [];
  let x = 1;
  entries.forEach(([p, n], i) => {
    /* ponytail: 最小段宽会让总宽略超出 W,溢出几像素无感,不做归一化 */
    const w = Math.max(10, usable * n / total);
    segs.push({ p, n, x, w, cx: x + w / 2, alpha: k === 1 ? .45 : .16 + .56 * i / (k - 1) });
    x += w + gap;
  });

  /* 写得下的段:注记静态写在自己正下方(不会互相打架,标签不宽于段宽)。
     写不下的窄段:注记+引线悬停才浮现,一次只看一个,不占版面 */
  const lw = s => (`P${s.p}×${s.n}`).length * 7 + 4;
  const anyNarrow = segs.some(s => s.w < lw(s) + 6);
  const height = anyNarrow ? H + 30 : H + 18;
  const svg = svgEl("svg", { class: "wipeStrip", width: W, height, viewBox: `0 0 ${W} ${height}` });
  for (const s of segs) {
    const g = svgEl("g", { class: "wipeSegG" }, svg);
    const pts = barPts(s.x, 1, s.w, H - 2, Math.min(5, s.w * .3), Math.min(4, s.w * .25));
    svgEl("path", { d: wobPath(pts, 1.1, true, rnd), fill: "var(--wipe-fill)", "fill-opacity": s.alpha.toFixed(2) }, g);
    svgEl("path", { d: wobPath(pts, .9, true, rnd), class: "segInk" }, g);
    const label = `P${s.p}×${s.n}`;
    const half = lw(s) / 2;
    if (s.w >= lw(s) + 6) {
      /* 静态注记放 g 外:色块弹跳时字纹丝不动 */
      svgEl("text", { x: s.cx, y: H + 13, class: "segNote", transform: `rotate(${(rnd() * 2).toFixed(1)} ${s.cx} ${H + 13})` }, svg)
        .textContent = label;
    } else {
      const lx = Math.min(Math.max(s.cx + 22, half), W - half);
      svgEl("path", { d: wobPath([[s.cx + 1, H + 1], [s.cx + (lx > s.cx ? 8 : -8), H + 11]], .5, false, rnd), class: "segLead segHoverOnly" }, g);
      svgEl("text", { x: lx, y: H + 25, class: "segNote segHoverOnly", transform: `rotate(-2 ${lx} ${H + 25})` }, g)
        .textContent = label;
    }
  }
  return svg;
}

function wipeDistribution(stat) {
  const entries = phaseEntries(stat.wipes);
  if (!entries.length) return null;
  const row = el("div", "wipeDist");
  row.appendChild(el("span", "wipeLabel", "灭点分布"));
  const track = el("button", "wipeTrack");
  track.type = "button";
  track.setAttribute("aria-label", "灭点分布:" + phaseText(stat.wipes));
  track.appendChild(wipeStrip(entries, 250, 18, seededRand(stat.ms + stat.pulls)));
  track.onclick = e => {
    const g = e.target.closest(".wipeSegG");
    if (!g) return;
    g.classList.remove("pop");
    void track.offsetWidth;
    g.classList.add("pop");
  };
  row.appendChild(track);
  return row;
}

function weeklyChart(stat) {
  const wrap = el("div", "weekStat");
  const head = el("div", "weekHead");
  head.appendChild(el("span", "weekTitle", "近7天战斗时长"));
  head.appendChild(el("span", "weekTotal", `${stat.pulls} 把 · ${durationText(stat.ms)}`));
  wrap.appendChild(head);

  const max = Math.max(...stat.days.map(d => d.ms), 1);
  const bars = el("div", "weekBars");
  const labels = el("div", "weekDays");
  stat.days.forEach(d => {
    const rnd = seededRand(d.key / DAY_MS);
    const bar = el("button", "weekBar");
    bar.type = "button";
    bar.style.setProperty("--h", `${d.ms ? Math.max(8, d.ms / max * 100) : 3}%`);
    bar.style.setProperty("--tilt", `${(rnd() * 1.2).toFixed(2)}deg`);
    bar.setAttribute("aria-label", `${d.label}，${d.pulls} 把，${durationText(d.ms)}，${phaseText(d.wipes)}`);

    const paint = svgEl("svg", { class: "weekPaint", viewBox: "0 0 100 104", preserveAspectRatio: "none", "aria-hidden": "true" });
    const h = d.ms ? Math.max(8, d.ms / max * 96) : 3;
    const x = 19, w = 62, top = 102 - h;
    const tc = Math.min(11, h * .55), bc = Math.min(3.5, h * .2);
    const pts = barPts(x, top, w, h, tc, bc);
    svgEl("path", { d: wobPath(pts, 1.6, true, rnd), class: "wash1" }, paint);
    if (h > 14) svgEl("path", { d: wobPath(barPts(x + 3, top + 3, w - 5, h - 5, tc, bc), 1.8, true, rnd), class: "wash2" }, paint);
    svgEl("path", { d: wobPath(pts, 1, true, rnd), class: "inkline" }, paint);
    bar.appendChild(paint);

    const tip = el("span", "weekTip");
    tip.appendChild(el("span", "tipTime", `${durationText(d.ms)} · ${d.pulls} 把`));
    tip.appendChild(el("span", "tipWipe", phaseText(d.wipes)));
    bar.appendChild(tip);
    bar.onclick = () => {
      const showWipes = !(bar.classList.contains("on") && bar.classList.contains("wipeOn"));
      bars.querySelectorAll(".weekBar.on, .weekBar.wipeOn").forEach(x => x.classList.remove("on", "wipeOn"));
      bar.classList.remove("pop");
      void bar.offsetWidth;
      bar.classList.add("pop");
      bar.classList.add("on");
      if (showWipes) bar.classList.add("wipeOn");
    };
    bar.onmouseleave = () => bar.classList.remove("on", "wipeOn");
    bars.appendChild(bar);
    labels.appendChild(el("span", "weekLabel", d.label));
  });
  wrap.appendChild(bars);

  const baseline = svgEl("svg", { class: "weekBase", viewBox: "0 0 600 8", preserveAspectRatio: "none", "aria-hidden": "true" });
  svgEl("path", { d: wobPath([[2, 4], [598, 3.5]], 1.4, false, seededRand(stat.days[0].key / DAY_MS + 7)) }, baseline);
  wrap.appendChild(baseline);
  wrap.appendChild(labels);

  const dist = wipeDistribution(stat);
  if (dist) wrap.appendChild(dist);
  return wrap;
}

async function updatePoints() {
  try {
    const d = await gql("{rateLimitData{ pointsSpentThisHour limitPerHour pointsResetIn }}");
    const r = d.rateLimitData;
    if (!r) return;
    const mins = Math.ceil((r.pointsResetIn || 0) / 60);
    const when = mins > 0 ? `，${mins} 分钟后重置` : "";
    $("#points").textContent = `查询额度已用 ${Math.round(r.pointsSpentThisHour)} / ${r.limitPerHour} 点${when}`;
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

let querySeq = 0;
let selectQueryOnFocus = false;
async function runQuery() {
  const raw = $("#q").value.trim();
  if (!raw && !currentChar) return;
  const seq = ++querySeq; // 新查询启动后，旧的在途查询作废
  hideSugg();
  const box = $("#result");
  box.innerHTML = "";
  box.appendChild(el("div", "spin", "查询中"));

  try {
    let name, server, note = null;
    if (currentChar && !raw) ({ name, server } = currentChar);
    else {
      const [n, s] = raw.includes("@") ? raw.split("@", 2) : [raw, ""];
      const r = await resolveCharacter(n.trim(), s.trim());
      if (seq !== querySeq) return;
      if (!r.name) {
        showMsg(s
          ? `FF Logs 上没找到角色「${n}@${s}」。\n确认服务器名和写法（黒/黑 已自动多试）；也可以只输入角色名全服自动找。\n查不到 ≠ 没打 —— 可能没传过 log。`
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

    // 15 分钟内同角色同副本复用结果；命中缓存时每 40 秒轻量探测一次新报告
    const lk = `${norm(name + "@" + server)}|${currentZone}`;
    const lastHit = cache.last[lk];
    let res;
    if (await canUseLastHit(lastHit, name, server, currentZone)) res = lastHit.v;
    else {
      res = await zoneProgress(name, server, currentZone);
      cache.last[lk] = { ts: Date.now(), v: res };
    }
    if (seq !== querySeq) return;
    const { rows, notFound } = res;
    box.querySelector(".spin")?.remove();
    if (notFound || !rows.length) {
      box.appendChild(el("div", "msg", "FF Logs 上没查到这个副本的记录。查不到不等于没打——可能没传过 log。"));
    }
    for (const row of rows) {
      if (!row.cleared) {
        if (row.pull) box.appendChild(pullCard(row.group, row.pull, progressText(row.pull), "prog", null, row.weekStat));
        else box.appendChild(pullCard(row.group, null, "无记录", "prog", null, row.weekStat));
        continue;
      }
      if (!head.querySelector(".clearBadge")) head.appendChild(clearBadge(row));
      if (row.weekKill) {
        // 通关时刻=那把的 endMs（boss 倒下那一刻），不是 startMs（那把开始时间）
        box.appendChild(pullCard(row.group, { ...row.weekKill, timeMs: row.weekKill.endMs },
          "最近通关", "clear", `近7天过本${row.weekStat?.kills || 1}次`, row.weekStat));
      } else if (row.weekPull) {
        box.appendChild(pullCard(row.group, row.weekPull, "近7天" + progressText(row.weekPull), "clear", null, row.weekStat));
      } else {
        box.appendChild(pullCard(row.group, null, "近7天无记录", "clear", null,
          row.weekStat?.pulls ? row.weekStat : null));
      }
    }
    updatePoints();
  } catch (e) {
    if (seq !== querySeq) return; // 已被新查询取代，别用旧错误盖掉新结果
    if (e instanceof FFLogsError && (e.message === "NEED_CONFIG" || e.message === "NEED_LOGIN")) {
      showMsg(e.message === "NEED_LOGIN"
        ? "FF Logs 登录已过期，请重新登录。"
        : "还没连接 FF Logs —— 登录一次就能查，1分钟搞定。", true);
      openSettings();
    } else {
      showMsg((e instanceof FFLogsError ? "" : "出错了：") + e.message, true);
    }
  } finally {
    saveCache();
    if (seq === querySeq) selectQueryOnFocus = true;
  }
}

/* ---- 搜索建议：本地历史即时 + 完整名停顿探测 ---- */
let probeTimer = null, probeSeq = 0;
function hideSugg() {
  clearTimeout(probeTimer);
  probeSeq++;
  $("#sugg").classList.add("hidden");
}

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
  selectQueryOnFocus = false;
  const v = $("#q").value.trim();
  currentChar = null;
  clearTimeout(probeTimer);
  probeSeq++;
  if (!v || v.includes("@")) { renderSugg([]); return; }
  const nv = norm(v);
  const local = history.filter(h => norm(h.name).startsWith(nv))
    .map(h => ({ name: h.name, server: h.server }));
  renderSugg(local);
  if (v.length < 2 || !hasAuth()) return;
  const seq = probeSeq;
  probeTimer = setTimeout(async () => {
    renderSugg([...local, { dim: true, text: "全服搜索中…" }]);
    try {
      const r = await searchCharacter(v, 1);
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

function selectQueryTextSoon() {
  const q = $("#q");
  if (!selectQueryOnFocus || !q.value) return;
  selectQueryOnFocus = false;        // 查完后只全选这一次,之后点击恢复正常编辑(光标落在点击处)
  requestAnimationFrame(() => q.select());
}

/* ---- 设置 / 登录 UI ---- */
function renderAuthUI() {
  const btn = $("#settingsBtn");
  if (userAuth && userAuth.base === config.base) btn.textContent = userAuth.name || "已登录";
  else if (config.clientId) btn.textContent = "API 设置";
  else btn.textContent = "登录 FF Logs";
}

function renderAuthBox() {
  const box = $("#authBox");
  box.innerHTML = "";
  if (userAuth && userAuth.base === config.base) {
    const row = el("div", "authRow");
    row.appendChild(el("span", "authName", "已登录：" + (userAuth.name || "FF Logs 用户")));
    const out = el("button", "ghost", "退出登录");
    out.type = "button";
    out.onclick = () => { saveUser(null); renderAuthBox(); };
    row.appendChild(out);
    box.appendChild(row);
  } else if (!OAUTH_CLIENT_ID) {
    box.appendChild(el("p", "note", "登录功能未启用（站长未配置 OAuth Client ID），请用下方高级方式。"));
  } else {
    const b = el("button", "loginBtn", "用 FF Logs 账号登录");
    b.type = "button";
    b.onclick = login;
    box.appendChild(b);
    box.appendChild(el("p", "hint", "跳转到 FF Logs 官网授权，本站不经手你的密码"));
  }
}

function openSettings() {
  renderAuthBox();
  $("#cfgId").value = config.clientId;
  $("#cfgSecret").value = config.clientSecret;
  $("#cfgBase").value = config.base;
  // 展开高级区：登录不可用，或本来就在用自带凭据且没登录
  $("#advBox").open = !OAUTH_CLIENT_ID || (!!config.clientId && !(userAuth && userAuth.base === config.base));
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
  renderAuthUI();
  updatePoints();
});

/* ---- 绑定 ---- */
$("#settingsBtn").onclick = openSettings;
$("#go").onclick = () => { currentChar = null; runQuery(); };
$("#q").addEventListener("input", onInput);
$("#q").addEventListener("focus", selectQueryTextSoon);
$("#q").addEventListener("click", selectQueryTextSoon);
$("#q").addEventListener("keydown", e => { if (e.isComposing) return; if (e.key === "Enter") { e.preventDefault(); currentChar = null; runQuery(); } });
$("#q").addEventListener("blur", () => setTimeout(hideSugg, 150));
renderChips();
(async () => {
  await handleOAuthCallback();   // 授权回跳先落地，再决定弹不弹引导
  renderAuthUI();
  if (!hasAuth()) openSettings();
  else updatePoints();
})();

const THEME_COLOR = { light: "#FAF3E5", dark: "#302F2E" };
$("#themeToggle").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.theme = next;
  document.querySelector('meta[name="theme-color"]').content = THEME_COLOR[next];
};
