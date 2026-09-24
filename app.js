/* No memes web 版 —— progress_query.py 的浏览器移植。
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
  { id: 76, label: "妖星乱舞绝境战", en: "Dancing Mad" },
  { id: 65, label: "光暗未来绝境战", en: "Futures Rewritten" },
  { id: 53, label: "欧米茄绝境验证战", en: "The Omega Protocol" },
  { id: 45, label: "幻想龙诗绝境战", en: "Dragonsong's Reprise" },
  { id: 32, label: "亚历山大绝境战", en: "The Epic of Alexander" },
  { id: 23, label: "究极神兵绝境战", en: "The Weapon's Refrain" },
  { id: 19, label: "巴哈姆特绝境战", en: "The Unending Coil of Bahamut" },
];

/* ============ 语言（zh 默认；en 用 FF Logs 英文站副本名） ============
 * LANG 是 let 不是 const：切换语言时原地改它 + 重渲染，不刷新整页，
 * 也就不会白白再发一次 rateLimitData/查询请求烧点数。 */
let LANG = localStorage.fpw_lang === "en" ? "en" : "zh";
const tr = (zh, en) => LANG === "en" ? en : zh;
const zoneLabel = z => LANG === "en" ? z.en : z.label;
const ENC_EN = Object.fromEntries(ZONE_TABS.map(z => [z.label, z.en]));
const encName = n => LANG === "en" ? (ENC_EN[n] || n) : n;   // API 返回国服名，查表转英文，查不到原样透传
const jobName = j => !j ? "" : LANG === "en" ? j.replace(/([a-z])([A-Z])/g, "$1 $2") : (JOB_ZH[j] || j);

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
  if (!r.ok) throw new FFLogsError(tr(`FF Logs 授权失败（HTTP ${r.status}）`, `FF Logs authorization failed (HTTP ${r.status})`));
  return r.json();
}

async function login() {
  if (!crypto.subtle) { showMsg(tr("登录需要 https 或 localhost 环境。", "Login requires https or localhost."), true); $("#settings").close(); return; }
  const verifier = randTok(), state = randTok();
  sessionStorage.setItem("fpw_pkce", JSON.stringify({ verifier, state }));
  // 登录往返会丢掉 ?c=&z=，先暂存，回跳后恢复
  try {
    const keep = new URLSearchParams();
    const raw = ($("#q")?.value || "").trim();
    if (raw) keep.set("c", raw);
    keep.set("z", String(currentZone));
    const s = keep.toString();
    if (s) sessionStorage.setItem("fpw_return_q", "?" + s);
  } catch {}
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
  const ret = sessionStorage.getItem("fpw_return_q") || "";
  sessionStorage.removeItem("fpw_return_q");
  window.history.replaceState(null, "", location.pathname + ret);   // history 变量被本文件遮蔽，须走 window
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem("fpw_pkce") || "null"); } catch {}
  sessionStorage.removeItem("fpw_pkce");
  if (q.get("error")) { showMsg(tr(`FF Logs 授权未完成（${q.get("error")}）。`, `FF Logs authorization not completed (${q.get("error")}).`), true); return; }
  if (!saved || saved.state !== q.get("state")) { showMsg(tr("登录校验失败（state 不匹配），请重新登录。", "Login validation failed (state mismatch), please log in again."), true); return; }
  try {
    const p = await oauthToken({
      grant_type: "authorization_code", redirect_uri: REDIRECT_URI,
      code: q.get("code"), code_verifier: saved.verifier,
    });
    saveUser({ token: p.access_token, refresh: p.refresh_token || null, exp: Date.now() + (p.expires_in || 3600) * 1000, base: config.base, name: null });
    await fetchUserInfo();
  } catch (e) {
    showMsg(tr("FF Logs 登录失败：", "FF Logs login failed: ") + e.message, true);
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
  if (!r.ok) throw new FFLogsError(tr(`OAuth 失败（HTTP ${r.status}）——检查 Client ID / Secret 是否正确`, `OAuth failed (HTTP ${r.status}) — check your Client ID / Secret`));
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
      throw new FFLogsError(tr("凭据失效，请重新保存 API 设置", "Credentials expired — re-save your API settings"));
    }
    if (r.status === 429) throw new FFLogsError(auth.user
      ? tr("FF Logs 限流（你的账号本小时点数用完），稍后再试", "FF Logs rate limited (your account's hourly points are used up), try again later")
      : tr("FF Logs 限流（本小时点数用完），稍后再试", "FF Logs rate limited (hourly points used up), try again later"));
    if (!r.ok) throw new FFLogsError(tr(`FF Logs 请求失败（HTTP ${r.status}）`, `FF Logs request failed (HTTP ${r.status})`));
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
  if (rid == null) throw new FFLogsError(tr("FF Logs 上没有 CN 大区", "No CN region on FF Logs"));
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
    ? tr(`已自动定位到最近活跃的 ${best.server}；${others.join("、")} 也有同名角色，查错了请用「角色名@服务器」精确指定。`,
         `Auto-picked ${best.server} (most recently active); the same name also exists on ${others.join(", ")}. If that's wrong, use "Name@Server".`)
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

// 返回 { results, fails }；fails = 网络/限流失败的报告数（空报告 ≠ 失败，不计入）
async function scanReports(items, wname, wserver, meta) {
  const out = [], misses = [];
  let fails = 0, failMsg = "";
  for (const it of items) {
    const hit = cache.scans[`${it.code}|${wname}|${wserver}`];
    if (hit) out.push(hit.r); else misses.push(it);
  }
  if (!misses.length) return { results: out, fails: 0, failMsg: "" };
  const chunks = [];
  for (let i = 0; i < misses.length; i += BATCH) chunks.push(misses.slice(i, i + BATCH));
  const noRetry = e => {   // 限流/要登录：重试没用还费点数
    const m = String(e?.message || e);
    return m === "NEED_LOGIN" || m.includes("限流") || m.includes("rate limited");
  };
  const results = await Promise.all(chunks.map(async chunk => {
    const alias = chunk.map((it, i) => `r${i}: report(code:${JSON.stringify(it.code)}){ ${REPORT_FIELDS} }`).join("\n");
    const q = `query{ reportData{ ${alias} }}`;
    try {
      let rd;
      try {
        rd = (await gql(q)).reportData || {};
      } catch (e) {
        if (noRetry(e)) throw e;
        await new Promise(r => setTimeout(r, 800));   // 瞬时 5xx/网络抖动：等一下重试一次
        rd = (await gql(q)).reportData || {};
      }
      return chunk.map((it, i) => parseReport(rd["r" + i] || {}, it.code, wname, wserver, meta));
    } catch (e) {
      fails += chunk.length;
      failMsg ||= String(e?.message || e);   // 留住真实原因，别再瞎猜限流还是网络
      console.warn("scanReports batch failed:", e);
      return chunk.map(() => null);   // 整批失败：不缓存，当空处理
    }
  }));
  chunks.forEach((chunk, ci) => chunk.forEach((it, i) => {
    const p = results[ci][i];
    if (p == null) { out.push({}); return; }
    if (it.ts && Date.now() - it.ts > IMMUTABLE_MS)
      cache.scans[`${it.code}|${wname}|${wserver}`] = { ts: Date.now(), r: p };
    out.push(p);
  }));
  return { results: out, fails, failMsg };
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
  if (!glist.length) throw new FFLogsError(tr("这个副本没有 encounter 数据", "No encounter data for this duty"));

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
  if (list == null) return { rows: [], notFound: true, reportStamp: "", scanFails: 0 };

  const zoneRows = list.filter(r => targetZones.has(r.zone)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const reportStamp = latestReportStamp(zoneRows);
  const scanSet = new Map();
  if (needScan.length) for (const r of zoneRows.slice(0, 40)) scanSet.set(r.code, r);
  for (const r of zoneRows) if ((r.ts || 0) >= scanCutoff) scanSet.set(r.code, r);

  let partials = [], scanFails = 0, scanFailMsg = "";
  if (scanSet.size) {
    const scanned = await scanReports([...scanSet.values()], norm(name), norm(server), await encMeta().then(m => m.meta));
    partials = scanned.results;
    scanFails = scanned.fails;
    scanFailMsg = scanned.failMsg;
  }

  const eidToGroup = {};
  for (const g of glist) for (const eid of g.eids) eidToGroup[eid] = g.name;
  const bestAll = {}, bestWeek = {}, weekPulls = {}, lastKill = {}, scanKill = {};
  for (const p of partials) for (const [eid, cand] of Object.entries(p)) {
    const gname = eidToGroup[eid];
    if (!gname) continue;
    if (!bestAll[gname] || rankLess(cand.rank, bestAll[gname].rank)) bestAll[gname] = cand;
    // rankings 被隐藏时兜底：报告里扫到的击杀（取扫描范围内最早那把）
    if (cand.cleared && (!scanKill[gname] || cand.endMs < scanKill[gname].endMs)) scanKill[gname] = cand;
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

  for (const g of needScan) {
    const fk = scanKill[g.name];
    if (fk) {
      // rankings 隐藏但报告里有击杀 → 按已通关渲染。
      // firstMs 留空:扫描只覆盖最近报告,最早那把不一定是真·首通,别谎报首通日期;
      // 也不写 cache.cleared,对方哪天取消隐藏就能拿到真实首通定格。
      rows.push({
        group: g.name, cleared: true, firstMs: null, job: fk.job,
        firstLink: `${config.base}/reports/${fk.code}#fight=${fk.fightId}`,
      });
    } else {
      rows.push({ group: g.name, cleared: false, pull: bestAll[g.name] || null, weekStat: weekStats[g.name] });
    }
  }
  for (const row of rows) if (row.cleared) {
    row.weekPull = bestWeek[row.group] || null;
    row.weekKill = lastKill[row.group] || null;   // 近7天最新的那把通关（带小队/职业/log 链接）
    row.weekStat = weekStats[row.group];
  }

  rows.sort((a, b) => (a.cleared ? 0 : 1) - (b.cleared ? 0 : 1) || ((a.pull?.fp ?? 999) - (b.pull?.fp ?? 999)));
  return { rows, reportStamp, scanFails, scanFailMsg };
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
    const c = el("button", "chip" + (currentZone === z.id ? " on" : ""), zoneLabel(z));
    c.type = "button";
    // 已定位角色时切换副本自动查；走 cache.last（1h）+ stamp 探测，通常不烧大额点数
    c.onclick = () => {
      if (currentZone === z.id) return;
      currentZone = z.id;
      renderChips();
      if (currentChar || ($("#q").value.includes("@") && $("#q").value.trim())) runQuery();
      else writeUrl(null, null, currentZone);
    };
    box.appendChild(c);
  }
}

/* ============ URL 深链 ?c=角色@服&z=zoneId（replaceState，不刷历史） ============ */
function writeUrl(name, server, zone) {
  try {
    const p = new URLSearchParams();
    if (name && server) p.set("c", `${name}@${server}`);
    else {
      const raw = ($("#q")?.value || "").trim();
      if (raw.includes("@")) p.set("c", raw);
    }
    p.set("z", String(zone ?? currentZone));
    const qs = p.toString();
    const next = location.pathname + (qs ? "?" + qs : "");
    if (next !== location.pathname + location.search) history.replaceState(null, "", next);
  } catch { /* 文件协议等环境忽略 */ }
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  const c = (p.get("c") || p.get("char") || "").trim();
  const zRaw = p.get("z") || p.get("zone");
  const z = zRaw != null && zRaw !== "" ? +zRaw : null;
  return { c, z: Number.isFinite(z) ? z : null };
}

function memberChip(p) {
  const d = el("div", `member ${roleOf(p.job)}` + (p.me ? " me" : ""));
  const img = el("img");
  img.src = `icons/${p.job}.png`;
  img.alt = p.job || "";
  img.title = jobName(p.job);
  img.onerror = () => img.remove();
  d.appendChild(img);
  const n = el("span", "mn");
  const nm = el("span", "mname", p.name || "?");
  if (p.me) nm.style.setProperty("--me-mark", crayonMask(hashSeed(p.name || "?"), p.name));
  n.appendChild(nm);
  if (p.server) n.appendChild(el("span", "ms", "@" + p.server));
  d.appendChild(n);
  return d;
}

function pullCard(title, pull, statusText, statusCls, extraWhen, weekStat) {
  const card = el("div", "card");
  const line = el("div", "bossline");
  line.appendChild(el("span", "boss", encName(title)));
  // 进度类只刷主文案；近7天真实击杀保留“最近通关 · 职业 · 时间”整条笔刷。
  const parts = [statusText];
  const whenParts = [];
  const metaParts = pull?.cleared && statusCls === "clear" ? parts : whenParts;
  if (pull?.job) metaParts.push(jobName(pull.job));
  if (pull?.timeMs) metaParts.push(fmtCST(pull.timeMs));
  const badge = el("span", "status " + statusCls);
  badge.appendChild(brushStroke(pull?.timeMs || 1, statusCls === "clear" ? null : "--brush-orange", parts.join(" · ")));
  badge.appendChild(el("span", "badgeTxt", parts.join(" · ")));
  line.appendChild(badge);
  if (extraWhen) whenParts.push(extraWhen);
  if (whenParts.length) line.appendChild(el("span", "when", whenParts.join(" · ")));
  if (pull?.code) {
    const a = el("a", "logLink", tr("查看 log ↗", "View log ↗"));
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

/* 状态词底下用彩铅涂一道:一层很淡的底色 + 来回的短斜线。
   viewBox 宽度按字数估出来,和实际尺寸接近 1:1,斜线不会被横向拉歪;铺满徽章仍靠 preserveAspectRatio=none */
function brushStroke(seed, brush, text) {
  const prefix = brush || "--brush-green";
  const rnd = seededRand(seed);
  const W = crayonWidth(text, 22);
  const H = 28;
  const m = crayonMark(W, H, 4.5, H - 3.5, rnd);
  const svg = svgEl("svg", { class: "badgeBrush", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  svgEl("path", { d: m.band, fill: `var(${prefix}-2)` }, svg);
  svgEl("path", { d: m.hatch, class: "crayon", stroke: `var(${prefix}-1)` }, svg);
  return svg;
}

// 按字数估宽度:中文 15、其他 8,再加两侧留白 pad
function crayonWidth(text, pad, min = 40) {
  return Math.max(min, [...(text || "")].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 15 : 8), pad));
}

/* 彩铅涂的一块:上下边跟着一道缓弯起伏,每根线有的没够到边、有的冲出去一点;
   两头是一根根线停下的地方,参差不齐,淡色底也跟着收成不规则的一头——不是尺子裁出来的色带 */
function crayonMark(W, H, y0, y1, rnd) {
  const f = v => v.toFixed(1);
  const edge = y => {
    const a = [9 + 6 * Math.abs(rnd()), rnd() * 6, 3 + 2 * Math.abs(rnd()), rnd() * 6];
    return x => y + .7 * Math.sin(x / a[0] + a[1]) + .3 * Math.sin(x / a[2] + a[3]);
  };
  const top = edge(y0), bot = edge(y1);
  const xl = 2 + 3 * Math.abs(rnd()), xr = W - 2 - 3 * Math.abs(rnd());
  // 斜线:比 45° 稍陡,逐根角度、间距、两头都不齐;碰到两头时各自停在不同的地方
  let hatch = "";
  for (let c = xl - (y1 - y0) / 1.35; c < xr; c += 3 * (.75 + .5 * Math.abs(rnd()))) {
    const k = 1.35 * (1 + rnd() * .07);
    let ax = c, ay = bot(c) + rnd() * .9;
    let bx = c + (ay - y0) / k, by = top(bx) + rnd() * .9;
    bx = c + (ay - by) / k;
    const L = xl + 2.5 * Math.abs(rnd()), R = xr - 2.5 * Math.abs(rnd());
    if (ax < L) { ay -= (L - ax) * k; ax = L; }
    if (bx > R) { by += (bx - R) * k; bx = R; }
    if (ay - by < 2) continue;
    const bend = rnd() * .5;
    hatch += `M${f(ax)},${f(ay)}Q${f((ax + bx) / 2 + bend)},${f((ay + by) / 2 + bend)} ${f(bx)},${f(by)}`;
  }
  // 淡色底:沿上下边取点,两头各三个点收成不齐的一头,再抹圆
  const pts = [];
  for (let x = xl + 2; x < xr - 2; x += 8) pts.push([x, top(x) + .6 + rnd() * .3]);
  const my = (y0 + y1) / 2;
  pts.push([xr - 1 + rnd(), top(xr) + 1.5], [xr + .8 * rnd(), my + rnd() * 2], [xr - 1.5 + rnd(), bot(xr) - 1]);
  for (let x = xr - 2; x > xl + 2; x -= 8) pts.push([x, bot(x) - .4 + rnd() * .3]);
  pts.push([xl + 1.5 + rnd(), bot(xl) - 1], [xl + .8 * rnd(), my + rnd() * 2], [xl + 1 + rnd(), top(xl) + 1.5]);
  const mid = (p, q) => f((p[0] + q[0]) / 2) + "," + f((p[1] + q[1]) / 2);
  let band = "M" + mid(pts[pts.length - 1], pts[0]);
  pts.forEach((p, i) => { band += "Q" + f(p[0]) + "," + f(p[1]) + " " + mid(p, pts[(i + 1) % pts.length]); });
  return { band: band + "Z", hatch };
}

/* 「本人」名字底下的彩铅:同一支笔,画成 mask 挂在 --me-mark 上(颜色在 CSS 里) */
function crayonMask(seed, text) {
  const W = crayonWidth(text, 10, 20), H = 24, m = crayonMark(W, H, 3.5, H - 3, seededRand(seed));
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none'>`
    + `<path d='${m.band}' fill-opacity='.4'/>`
    + `<path d='${m.hatch}' fill='none' stroke='#000' stroke-width='1.5' stroke-linecap='round' stroke-opacity='.85'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
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
  const text = [tr("已通关", "Cleared"), jobName(row.job), date].filter(Boolean).join(" · ");
  a.appendChild(brushStroke(row.firstMs || 1, null, text));
  a.appendChild(el("span", "badgeTxt", text));
  return a;
}

function progressText(pull) {
  const p = pull.phase ? `P${pull.phase}` : tr("未知阶段", "unknown phase");
  const hp = pull.hp == null ? tr("未知", "unknown") : pull.hp + "%";
  return pull.cleared ? tr("击杀", "Kill") : tr(`最远 ${p}（boss 剩 ${hp}）`, `best ${p} (boss at ${hp})`);
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
  if (mins < 60) return `${mins} ${tr("分钟", "min")}`;
  const hours = mins / 60;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} ${tr("小时", "h")}`;
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
  return entries.length ? entries.map(([p, n]) => `P${p}×${n}`).join(" · ") : tr("无灭点记录", "no wipe data");
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

/* 钢笔的一笔直线:没用尺子,中段微微鼓出去一点、一路轻微抖;两端各随手出头一点(手画的方框角上总会交叉) */
function penStroke(x1, y1, x2, y2, rnd, over = 0, amp = .6) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const o1 = over * (.3 + .7 * Math.abs(rnd())), o2 = over * (.3 + .7 * Math.abs(rnd()));
  const bow = rnd() * Math.min(1.5, len / 60);
  return wobPath([[x1 - ux * o1 + rnd() * .4, y1 - uy * o1 + rnd() * .4],
                  [(x1 + x2) / 2 - uy * bow, (y1 + y2) / 2 + ux * bow],
                  [x2 + ux * o2 + rnd() * .4, y2 + uy * o2 + rnd() * .4]], amp, false, rnd);
}

/* 钢笔画的方框:四条边各自一笔、角上出头;bottom=false 时不画底边(柱子立在基线上) */
function sketchBox(x, y, w, h, rnd, over, bottom = true) {
  let d = penStroke(x, y + h, x, y, rnd, over) + penStroke(x, y, x + w, y, rnd, over)
        + penStroke(x + w, y, x + w, y + h, rnd, over);
  if (bottom) d += penStroke(x + w, y + h, x, y + h, rnd, over);
  return d;
}

/* 斜线排线:在方框里画一组大致平行的斜线,比 45° 稍陡(手腕自然的角度)。
   手排的线不齐:每根角度差一点、间距忽疏忽密、两头有的没够到边有的冲出去一点、线身微微弯 */
function hatchPath(x, y, w, h, gap, rnd) {
  const f = v => v.toFixed(1);
  let d = "";
  for (let c = x - h / 1.35 + gap * (.3 + .5 * Math.abs(rnd())); c < x + w; c += gap * (.75 + .5 * Math.abs(rnd()))) {
    const k = 1.35 * (1 + rnd() * .07);
    const t0 = Math.max(-.6, Math.max(0, (x - c) * k) + Math.abs(rnd()) * 1.8 - .5);
    const t1 = Math.min(h + .6, Math.min(h, (x + w - c) * k) - Math.abs(rnd()) * 1.8 + .5);
    if (t1 - t0 < 1.2) continue;
    const ax = c + t0 / k, bx = c + t1 / k;
    const ay = y + h - t0, by = y + h - t1, bend = rnd() * .5;
    d += `M${f(ax)},${f(ay)}Q${f((ax + bx) / 2 + bend)},${f((ay + by) / 2 + bend)} ${f(bx)},${f(by)}`;
  }
  return d;
}

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

/* 比例分段的灭点条:段长∝次数,每段是钢笔方框+排线,排线按在场 P 数从疏到密。
   数字全部写在条下方当轴注记(块内无字);和左邻打架的注记降一行用引线避让 */
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
    const t = k === 1 ? .5 : i / (k - 1);   // 0=最早的 P,1=最远的 P
    segs.push({ p, n, x, w, cx: x + w / 2, gap: 6.5 - 3.8 * t });
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
    svgEl("rect", { x: s.x, y: 1, width: s.w, height: H - 2, class: "segHit" }, g);   // 排线之间的空隙也要能点到
    svgEl("path", { d: hatchPath(s.x, 2, s.w, H - 4, s.gap, rnd), class: "segHatch" }, g);
    svgEl("path", { d: sketchBox(s.x, 1, s.w, H - 2, rnd, 1.6), class: "segInk" }, g);
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
  row.appendChild(el("span", "wipeLabel", tr("灭点分布", "Wipes by phase")));
  const track = el("button", "wipeTrack");
  track.type = "button";
  track.setAttribute("aria-label", tr("灭点分布:", "Wipes by phase: ") + phaseText(stat.wipes));
  track.appendChild(wipeStrip(entries, 300, 22, seededRand(stat.ms + stat.pulls)));
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
  head.appendChild(el("span", "weekTitle", tr("近7天战斗时长", "Combat time, last 7 days")));
  head.appendChild(el("span", "weekTotal", `${stat.pulls} ${tr("把", "pulls")} · ${durationText(stat.ms)}`));
  wrap.appendChild(head);

  const max = Math.max(...stat.days.map(d => d.ms), 1);
  const bars = el("div", "weekBars");
  const labels = el("div", "weekDays");
  stat.days.forEach(d => {
    const rnd = seededRand(d.key / DAY_MS);
    const bar = el("button", "weekBar");
    bar.type = "button";
    bar.style.setProperty("--h", `${d.ms ? Math.max(8, d.ms / max * 100) : 3}%`);
    bar.setAttribute("aria-label", tr(`${d.label}，${d.pulls} 把，${durationText(d.ms)}，${phaseText(d.wipes)}`,
      `${d.label}, ${d.pulls} pulls, ${durationText(d.ms)}, ${phaseText(d.wipes)}`));

    const paint = svgEl("svg", { class: "weekPaint", viewBox: "0 0 100 104", preserveAspectRatio: "none", "aria-hidden": "true" });
    /* 铅笔画的柱子:三条边各一笔(底边就是基线),里面斜线排线;悬停/选中时线条换成彩铅色(CSS) */
    const x = 21, w = 58;
    if (d.ms) {
      const h = Math.max(8, d.ms / max * 96), top = 102 - h;
      svgEl("path", { d: hatchPath(x + 1, top + 1.5, w - 2, h - 1.5, 5, rnd), class: "hatch" }, paint);
      svgEl("path", { d: sketchBox(x, top, w, h, rnd, 2.6, false), class: "inkline" }, paint);
    } else {
      svgEl("path", { d: penStroke(x + w * .3, 100.5, x + w * .7, 100, rnd), class: "inkline zero" }, paint);   // 没打的那天:一小横
    }
    bar.appendChild(paint);

    const tip = el("span", "weekTip");
    tip.appendChild(el("span", "tipTime", `${durationText(d.ms)} · ${d.pulls} ${tr("把", "pulls")}`));
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
  svgEl("path", { d: penStroke(4, 4, 596, 3.4, seededRand(stat.days[0].key / DAY_MS + 7), 3, .7) }, baseline);
  wrap.appendChild(baseline);
  wrap.appendChild(labels);

  const dist = wipeDistribution(stat);
  if (dist) wrap.appendChild(dist);
  return wrap;
}

let lastPoints = null;   // 缓存上次额度数据，切换语言时按新语言重画（不重新请求，不烧点）
function renderPoints() {
  const r = lastPoints;
  if (!r) return;
  const mins = Math.ceil((r.pointsResetIn || 0) / 60);
  const when = mins > 0 ? tr(`，${mins} 分钟后重置`, `, resets in ${mins} min`) : "";
  $("#points").textContent = tr(`API额度已用 ${Math.round(r.pointsSpentThisHour)} / ${r.limitPerHour} 点${when}`,
    `API points used ${Math.round(r.pointsSpentThisHour)} / ${r.limitPerHour}${when}`);
}

async function updatePoints() {
  try {
    const d = await gql("{rateLimitData{ pointsSpentThisHour limitPerHour pointsResetIn }}");
    if (!d.rateLimitData) return;
    lastPoints = d.rateLimitData;
    renderPoints();
  } catch { /* 点数显示是装饰，失败不打扰 */ }
}

function showMsg(text, isErr) {
  const box = $("#result");
  box.innerHTML = "";
  box.appendChild(el("div", "msg" + (isErr ? " err" : ""), text));
}

function renderEmptyState() {
  const box = $("#result");
  box.innerHTML = "";
  if (!history.length) {
    box.appendChild(el("div", "msg", tr(
      "输入角色名开始查询，支持「角色名@服务器」精确指定。",
      "Type a character name to search; use Name@Server to be precise.")));
    return;
  }
  const wrap = el("div", "emptyHistory");
  wrap.appendChild(el("div", "ehTitle", tr("最近查询", "Recent — tap to re-run")));
  const chipsBox = el("div", "chips");
  for (const h of history.slice(0, 10)) {
    const c = el("button", "chip", `${h.name}@${h.server}`);
    c.type = "button";
    c.onclick = () => {
      $("#q").value = `${h.name}@${h.server}`;
      currentChar = null;
      runQuery();
    };
    chipsBox.appendChild(c);
  }
  wrap.appendChild(chipsBox);
  box.appendChild(wrap);
}

function pushHistory(name, server) {
  history = [{ name, server, ts: Date.now() },
    ...history.filter(h => !(h.name === name && h.server === server))].slice(0, 20);
  LS.set("fpw_history", history);
}

// 结果面板的纯渲染部分：从 res 数据出发画 DOM，不发任何请求。
// 语言切换时用它对着已有数据重画一遍（换文案而已），避免为了换语言又白烧一次点数。
let lastRender = null;   // { name, server, res, note }
function renderResultBox(name, server, res, note) {
  lastRender = { name, server, res, note };
  const box = $("#result");
  box.innerHTML = "";
  const { rows, notFound, scanFails = 0, scanFailMsg = "" } = res;
  const head = el("div", "charHead");
  // 头像职业:按「最近通关 → 近7天最远那把 → 最远进度那把」取实打实的那一把;
  // 过本了但近7天一条记录都没有,才回退到 row.job(历史通关里用得最多的职业)。
  // 注意:回退前它可能和右边徽章印的职业名不一致,这是有意的——图标说「最近在拿什么打」。
  const myJob = rows.map(r => r.weekKill?.job || r.weekPull?.job || r.pull?.job || r.job).find(Boolean);
  if (myJob) {
    const img = el("img", "charJob");
    img.src = `icons/${myJob}.png`;
    img.alt = "";
    img.title = jobName(myJob);
    img.onerror = () => img.remove();
    head.appendChild(img);
  }
  // 名字和服务器拉开字号:整行同一个 27px 是「单调」的来源
  const who = el("span", "who");
  who.appendChild(el("span", "whoName", name));
  who.appendChild(el("span", "whoAt", "@"));
  who.appendChild(el("span", "whoServer", server));
  head.appendChild(who);
  const curTab = ZONE_TABS.find(z => z.id === currentZone);
  head.appendChild(el("span", "meta", curTab ? zoneLabel(curTab) : ""));
  box.appendChild(head);
  if (note) box.appendChild(el("div", "notice", "⚠ " + note));

  if (scanFails > 0) {
    const why = scanFailMsg || tr("限流或网络", "rate limit or network");
    box.appendChild(el("div", "notice warn",
      tr(`⚠ 有 ${scanFails} 份报告加载失败（${why}），结果可能不完整。稍后再点查询重试，一般不重复扣已成功缓存的点数。`,
         `⚠ ${scanFails} report(s) failed to load (${why}); results may be incomplete. Retry later — successfully cached reports won't cost points again.`)));
  }
  if (notFound || !rows.length) {
    box.appendChild(el("div", "msg", tr("FF Logs 上没查到这个副本的记录。查不到不等于没打——可能没传过 log。",
      "No records for this duty on FF Logs. Not found ≠ never played — maybe no logs were uploaded.")));
  }
  for (const row of rows) {
    if (!row.cleared) {
      if (row.pull) box.appendChild(pullCard(row.group, row.pull, progressText(row.pull), "prog", null, row.weekStat));
      else box.appendChild(pullCard(row.group, null, tr("无记录", "No records"), "prog", null, row.weekStat));
      continue;
    }
    if (!head.querySelector(".clearBadge")) head.appendChild(clearBadge(row));
    if (row.weekKill) {
      // 通关时刻=那把的 endMs（boss 倒下那一刻），不是 startMs（那把开始时间）
      box.appendChild(pullCard(row.group, { ...row.weekKill, timeMs: row.weekKill.endMs },
        tr("最近通关", "Latest clear"), "clear",
        tr(`近7天过本${row.weekStat?.kills || 1}次`, `${row.weekStat?.kills || 1} clear(s) in last 7 days`), row.weekStat));
    } else if (row.weekPull) {
      box.appendChild(pullCard(row.group, row.weekPull,
        tr("近7天" + progressText(row.weekPull), "Last 7 days: " + progressText(row.weekPull)), "clear", null, row.weekStat));
    } else {
      box.appendChild(pullCard(row.group, null, tr("近7天无记录", "No pulls in last 7 days"), "clear", null,
        row.weekStat?.pulls ? row.weekStat : null));
    }
  }
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
  box.appendChild(el("div", "spin", tr("查询中", "Searching")));

  try {
    let name, server, note = null;
    if (currentChar && !raw) ({ name, server } = currentChar);
    else {
      const [n, s] = raw.includes("@") ? raw.split("@", 2) : [raw, ""];
      const r = await resolveCharacter(n.trim(), s.trim());
      if (seq !== querySeq) return;
      if (!r.name) {
        showMsg(s
          ? tr(`FF Logs 上没找到角色「${n}@${s}」。\n确认服务器名和写法（黒/黑 已自动多试）；也可以只输入角色名全服自动找。\n查不到 ≠ 没打 —— 可能没传过 log。`,
               `Character "${n}@${s}" not found on FF Logs.\nCheck the server name and spelling (黒/黑 variants auto-tried); you can also enter just the name to search all servers.\nNot found ≠ never played — they may just never have uploaded a log.`)
          : tr(`全国服都没搜到叫「${n}」且传过 log 的角色。\n确认名字写法；「没找到 ≠ 没打」——可能没传过 log，或传到了国际服站。`,
               `No character named "${n}" with uploaded logs found on any CN server.\nCheck the spelling; not found ≠ never played — maybe no logs uploaded, or they were uploaded to the international site.`));
        return;
      }
      ({ name, server } = r); note = r.note;
      currentChar = { name, server };
      pushHistory(name, server);
      $("#q").value = `${name}@${server}`;
    }

    box.innerHTML = "";
    box.appendChild(el("div", "spin", tr("查询中", "Searching")));

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
    writeUrl(name, server, currentZone);
    renderResultBox(name, server, res, note);
    updatePoints();
  } catch (e) {
    if (seq !== querySeq) return; // 已被新查询取代，别用旧错误盖掉新结果
    if (e instanceof FFLogsError && (e.message === "NEED_CONFIG" || e.message === "NEED_LOGIN")) {
      showMsg(e.message === "NEED_LOGIN"
        ? tr("FF Logs 登录已过期，请重新登录。", "FF Logs login expired, please log in again.")
        : tr("还没连接 FF Logs —— 登录一次就能查。", "Not connected to FF Logs yet — log in once and you're set, takes a minute."), true);
      openSettings();
    } else {
      showMsg((e instanceof FFLogsError ? "" : tr("出错了：", "Error: ")) + e.message, true);
    }
  } finally {
    saveCache();
    if (seq === querySeq) selectQueryOnFocus = true;
  }
}

/* ---- 搜索建议：本地历史即时；远程全服探测极省点 ----
 * 远程 31 服别名很贵 → 仅当：本地无命中、≥3 字、已登录、停顿 1.2s 才探一次；
 * probeCache 10 分钟复用；有本地历史时完全不打远程（回车仍可全服正式查）。 */
const SUGGEST_DEBOUNCE_MS = 1200;
const SUGGEST_MIN_LEN = 3;
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
  // 有本地历史 → 不烧远程点；字太少 / 未登录也不探
  if (local.length || v.length < SUGGEST_MIN_LEN || !hasAuth()) return;
  const seq = probeSeq;
  probeTimer = setTimeout(async () => {
    const cached = probeCache.get(v);
    const cacheFresh = cached && Date.now() - cached.ts < PROBE_CACHE_TTL;
    if (!cacheFresh) renderSugg([...local, { dim: true, text: tr("全服搜索中…", "Searching all servers… (costs points; Enter searches directly)") }]);
    try {
      const r = await searchCharacter(v, 1);
      if (seq !== probeSeq) return;
      const remote = (r.hits || []).filter(h => h.lastTs > 0)
        .map(h => ({ name: h.name, server: h.server, when: h.lastTs ? fmtCST(h.lastTs).slice(0, 5) : "" }))
        .filter(h => !local.some(l => l.name === h.name && l.server === h.server));
      if (!remote.length && !local.length)
        renderSugg([{ dim: true, text: tr("暂无上传过 log 的同名角色", "No character with uploaded logs by that name · press Enter to retry") }]);
      else renderSugg([...local, ...remote]);
      saveCache();
    } catch (e) {
      if (seq !== probeSeq) return;
      const tip = (e instanceof FFLogsError && /限流|rate limit/i.test(e.message))
        ? tr("额度紧张，建议稍后再试", "Points running low — press Enter to search, or try later")
        : tr("远程搜索失败", "Remote search failed — press Enter to search directly");
      renderSugg([...local, { dim: true, text: tip }]);
    }
  }, SUGGEST_DEBOUNCE_MS);
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
  if (userAuth && userAuth.base === config.base) btn.textContent = userAuth.name || tr("已登录", "Signed in");
  else if (config.clientId) btn.textContent = tr("API 设置", "API settings");
  else btn.textContent = tr("登录 FF Logs", "Log in to FF Logs");
}

function renderAuthBox() {
  const box = $("#authBox");
  box.innerHTML = "";
  if (userAuth && userAuth.base === config.base) {
    const row = el("div", "authRow");
    row.appendChild(el("span", "authName", tr("已登录：", "Signed in: ") + (userAuth.name || tr("FF Logs 用户", "FF Logs user"))));
    const out = el("button", "ghost", tr("退出登录", "Sign out"));
    out.type = "button";
    out.onclick = () => { saveUser(null); renderAuthBox(); };
    row.appendChild(out);
    box.appendChild(row);
  } else if (!OAUTH_CLIENT_ID) {
    box.appendChild(el("p", "note", tr("登录功能未启用（站长未配置 OAuth Client ID），请用下方高级方式。",
      "Login is not enabled (site owner hasn't set an OAuth Client ID); use the advanced option below.")));
  } else {
    const b = el("button", "loginBtn", tr("用 FF Logs 账号登录", "Log in with FF Logs"));
    b.type = "button";
    b.onclick = login;
    box.appendChild(b);
    box.appendChild(el("p", "hint", tr("跳转到 FF Logs 官网授权，本站不经手你的密码",
      "Redirects to FF Logs for authorization; this site never sees your password")));
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

/* ---- 语言切换：原地重渲染，不刷新整页 ----
 * HTML 源文案是中文；applyStaticLang() 双向覆写（不像之前只在 en 分支覆写一次），
 * 这样切回 zh 也能原样还原，不需要 location.reload()。 */
function applyStaticLang() {
  document.documentElement.dataset.lang = LANG;
  document.documentElement.lang = LANG === "en" ? "en" : "zh-CN";
  $("#langToggle").querySelector(".tw.zh").textContent = tr("中", "Chinese");
  $("#langToggle").querySelector(".tw.en").textContent = tr("英", "English");
  $("#langToggle").title = tr("切换语言", "Switch language");
  $("#themeToggle").title = tr("切换外观", "Toggle appearance");
  $("#settingsBtn").title = tr("连接 FF Logs", "Connect FF Logs");
  $("#q").placeholder = tr("角色名，或 角色名@服务器", "Character, or Character@Server");
  $("#go").textContent = tr("查询", "Search");
  document.querySelector(".searchHint").textContent = tr(
    "基于 FF Logs 的公开数据，上传了才能查到。查不到不等于没打",
    "Based on public FF Logs data — only uploaded logs show up. Not found ≠ never played");
  $("#settings h2").textContent = tr("连接 FF Logs", "Connect FF Logs");
  $("#advBox summary").textContent = tr("使用自己的 API Client（高级）", "Use your own API client (advanced)");
  $("#advBox .note").innerHTML = tr(
    '在 <a href="https://cn.fflogs.com/api/clients/" target="_blank" rel="noopener">cn.fflogs.com/api/clients</a> ' +
    '创建一个 Client（名字随意，Redirect URL 填 <code>https://localhost</code> 即可）， ' +
    '把 Client ID 和 Client Secret 粘贴到这里然后点击保存。凭据只存在你自己的浏览器里。',
    'Create a client at <a href="https://cn.fflogs.com/api/clients/" target="_blank" rel="noopener">cn.fflogs.com/api/clients</a> ' +
    '(any name; set Redirect URL to <code>https://localhost</code>), then paste the Client ID and Client Secret here and hit Save. ' +
    'Credentials are stored only in your own browser.');
  $("#cfgBase").parentElement.firstChild.nodeValue = tr("FF Logs 站点", "FF Logs site");
  $("#cfgSave").textContent = tr("保存", "Save");
  document.querySelector('#settings button[value="cancel"]').textContent = tr("关闭", "Close");
}
applyStaticLang();
$("#langToggle").onclick = () => {
  LANG = LANG === "en" ? "zh" : "en";
  localStorage.fpw_lang = LANG;
  applyStaticLang();
  renderChips();
  renderAuthUI();
  renderPoints();
  if (lastRender) renderResultBox(lastRender.name, lastRender.server, lastRender.res, lastRender.note);
  else if (hasAuth()) renderEmptyState();
};

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
  // 深链：?c=角色@服&z=76 —— 有鉴权才自动查，避免未登录白烧一轮
  const deep = readUrl();
  if (deep.z && ZONE_TABS.some(t => t.id === deep.z)) {
    currentZone = deep.z;
    renderChips();
  }
  if (deep.c) $("#q").value = deep.c;
  if (!hasAuth()) openSettings();
  else {
    updatePoints();
    if (deep.c) {
      currentChar = null;
      runQuery();
    } else renderEmptyState();
  }
})();

const THEME_COLOR = { light: "#D8D3CC", dark: "#0F0C0A" };
$("#themeToggle").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.theme = next;
  document.querySelector('meta[name="theme-color"]').content = THEME_COLOR[next];
};

/* ============ 手绘框:按钮/气泡的边框和水彩涂色,都按实际尺寸现画 ============
   每个元素画两张 mask(SVG),挂在 CSS 变量 --ink-frame / --ink-fill 上:::after 显示钢笔框,::before 显示水彩涂色;
   颜色仍由 CSS 决定,换主题不用重画。框是字写得好的人一笔画下来的:线稳,角收得紧(小圆角),
   边只是微微不直(每条边一道很缓的弧),收笔越过起笔一小截、稍稍错开一点再收尖。
   尺寸变了(换语言、切副本)就按同一个种子重画,同一个按钮每次画出来都一样。 */
const INK_PAD = 6;   // 画布比元素四周各大 6px,给出头的笔画留地方;CSS 里伪元素的 inset 要和它对上
const INK_SEL = "button:not(.weekBar):not(.wipeTrack), .weekTip";
const FOCUS_RING = 5;   // 键盘焦点那一圈离按钮 5px;CSS 里 :focus-visible 的 ::after inset -12.5px = 5 + INK_PAD + 1.5 边框

function hashSeed(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 2147483646 + 1;
}

/* 圆角矩形的周长参数化:at(s) 给出周长上第 s 像素处的点和朝外的法线(从上边偏左开始、顺时针)。
   四个角各给一个半径 [左上, 右上, 右下, 左下]——手画的框四个角不会一样圆 */
function roundRect(x0, y0, x1, y1, radii) {
  const [a, b, c, d] = radii.map(r => Math.max(1, r));
  const segs = [   // [长度, s→点] 依次:上边、右上角、右边、右下角、下边、左下角、左边、左上角
    [x1 - x0 - a - b, s => [x0 + a + s, y0, 0, -1]],
    [Math.PI * b / 2, s => arc(x1 - b, y0 + b, b, -Math.PI / 2 + s / b)],
    [y1 - y0 - b - c, s => [x1, y0 + b + s, 1, 0]],
    [Math.PI * c / 2, s => arc(x1 - c, y1 - c, c, s / c)],
    [x1 - x0 - c - d, s => [x1 - c - s, y1, 0, 1]],
    [Math.PI * d / 2, s => arc(x0 + d, y1 - d, d, Math.PI / 2 + s / d)],
    [y1 - y0 - d - a, s => [x0, y1 - d - s, -1, 0]],
    [Math.PI * a / 2, s => arc(x0 + a, y0 + a, a, Math.PI + s / a)],
  ];
  function arc(cx, cy, r, t) { return [cx + r * Math.cos(t), cy + r * Math.sin(t), Math.cos(t), Math.sin(t)]; }
  const P = segs.reduce((n, g) => n + g[0], 0);
  const start = segs.map((_, i) => segs.slice(0, i).reduce((n, g) => n + g[0], 0));   // 每段起点的弧长
  const at = s => {
    s = ((s % P) + P) % P;
    for (const [len, fn] of segs) { if (s < len) return fn(s); s -= len; }
    return segs[0][1](0);
  };
  return { P, start, at };
}

/* 沿中心线按每点的笔宽往两侧偏,围成一个填充多边形——线才有轻重,不是一根等宽的描边 */
function strokeOutline(pts, widths) {
  const L = [], R = [], f = v => v.toFixed(1);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let nx = a[1] - b[1], ny = b[0] - a[0];
    const n = Math.hypot(nx, ny) || 1, hw = widths[i] / 2;
    nx /= n; ny /= n;
    L.push(f(pts[i][0] + nx * hw) + " " + f(pts[i][1] + ny * hw));
    R.push(f(pts[i][0] - nx * hw) + " " + f(pts[i][1] - ny * hw));
  }
  return "M" + L.concat(R.reverse()).join("L") + "Z";
}

function inkFrame(w, h, seed, weight) {
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${w + 2 * INK_PAD}' height='${h + 2 * INK_PAD}' viewBox='0 0 ${w + 2 * INK_PAD} ${h + 2 * INK_PAD}'>`
    + `<path d='${inkFramePath(w, h, seed, weight)}'/></svg>`;
}

function inkFramePath(w, h, seed, weight) {
  const rnd = seededRand(seed), W = w + 2 * INK_PAD, H = h + 2 * INK_PAD;
  const r = Math.min(5, h / 7);
  const jit = [0, 1, 2, 3].map(() => .7 * rnd()), rk = [0, 1, 2, 3].map(() => .55 + .6 * Math.abs(rnd()));
  // 每条边一道很缓的弧(中段鼓出不到 1px,角上归零),整圈再叠一道极长的波:线是稳的,只是不像尺子拉的。
  // 往里凹只留三成:手画的边很少往里凹,凹多了两头就像往外翘,角显得往外戳
  const bows = [0, 1, 2, 3].map(() => 1.1 * rnd()).map(b => b < 0 ? b * .3 : b), ph = [0, 1].map(() => rnd() * 6);
  // 角两边都往里凹时,角会显得往外戳,这个角就圆一点(角 i 夹在边 i-1 和边 i 之间:上 右 下 左)
  const radii = rk.map((k, i) => r * k * (1 + .45 * Math.min(1, Math.max(0, -(bows[(i + 3) % 4] + bows[i]) / 1.6))));
  const rr = roundRect(INK_PAD + jit[0], INK_PAD + jit[1], W - INK_PAD + jit[2], H - INK_PAD + jit[3], radii);
  const bend = s => {
    const q = ((s % rr.P) + rr.P) % rr.P;
    let b = 0;
    for (let i = 0; i < 8; i += 2) {
      const a = rr.start[i], L = rr.start[i + 1] - a;
      if (q >= a && q < a + L) b = bows[i / 2] * Math.sin(Math.PI * (q - a) / L);
    }
    return b + .3 * Math.sin(q / rr.P * 12.566 + ph[0]);
  };
  const top = rr.start[1] - rr.start[0];
  const s0 = top * (.12 + .25 * Math.abs(rnd()));               // 从上边偏左落笔
  const over = 9 + 7 * Math.abs(rnd());                          // 收笔越过起笔一小截
  const len = rr.P + over;
  const drift = 1.2 + .6 * Math.abs(rnd());                       // 那一截往外错开一点,和起笔不完全重合
  const pts = [], ws = [];
  for (let s = 0; s <= len; s += 2) {
    const [x, y, nx, ny] = rr.at(s0 + s);
    const k = Math.max(0, 1 - (len - s) / (over + 24));          // 最后一段才开始错开
    const off = bend(s0 + s) + drift * k * k;
    pts.push([x + nx * off, y + ny * off]);
    // 落笔先压一下(稍粗),中段稳,收笔在最后十几像素收尖
    const land = 1 + .18 * Math.max(0, 1 - s / 8);
    const taper = Math.min(1, .55 + s / 6) * (.12 + .88 * Math.min(1, (len - s) / 14));
    ws.push(weight * land * taper * (1 + .07 * Math.max(0, nx + ny)) * (1 + .08 * Math.sin(s / 29 + ph[1])));
  }
  return strokeOutline(pts, ws);
}

/* 水彩涂色:一整片淡彩,不是线。形状比框往里收 2px 上下,边缘软、微微不齐;
   颜料在边上积得深一点(水彩干了的那圈边),中间有大块的深浅不匀。
   soft=true 是暗色用的一份:黑底上颜料淡的地方透出黑来,大块深浅不匀会读成污渍,所以不匀压到三成、积边收一点(平均浓度不变) */
function inkFill(w, h, seed, soft) {
  const rnd = seededRand(seed + 17), W = w + 2 * INK_PAD, H = h + 2 * INK_PAD, f = v => v.toFixed(1);
  const x0 = INK_PAD + 1.8, y0 = INK_PAD + 1.8, x1 = W - INK_PAD - 1.8, y1 = H - INK_PAD - 1.8;
  const rr = roundRect(x0, y0, x1, y1, [0, 1, 2, 3].map(() => Math.min(4, h / 9) * (.6 + .6 * Math.abs(rnd()))));
  const ph = [rnd() * 6, rnd() * 6];
  const blob = [];
  for (let s = 0; s < rr.P; s += 3) {
    const [x, y, nx, ny] = rr.at(s), o = 1.1 * Math.sin(s / 41 + ph[0]) + .3 * Math.sin(s / 13 + ph[1]);
    blob.push(f(x + nx * o) + " " + f(y + ny * o));
  }
  const sd = seed % 997, mot = soft ? .36 : 1.2, ring = soft ? .18 : .3;   // mot:浓淡随噪声变化的幅度,平均浓度都是 .55
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>`
    + `<filter id='w' color-interpolation-filters='sRGB'>`
    // 边缘:轻轻扰动一下再柔一点
    + `<feTurbulence type='fractalNoise' baseFrequency='.09' numOctaves='2' seed='${sd}' result='e'/>`
    + `<feDisplacementMap in='SourceGraphic' in2='e' scale='1.6' xChannelSelector='R' yChannelSelector='G' result='d'/>`
    + `<feGaussianBlur in='d' stdDeviation='.5' result='s'/>`
    // 积在边上的那圈:形状减去自己的模糊,只剩贴边往里几像素
    + `<feGaussianBlur in='d' stdDeviation='3.5' result='b'/>`
    + `<feComposite in='s' in2='b' operator='arithmetic' k2='1' k3='-1' result='ring'/>`
    // 大块的深浅不匀
    + `<feTurbulence type='fractalNoise' baseFrequency='.025 .05' numOctaves='2' seed='${sd + 7}' result='m'/>`
    + `<feColorMatrix in='m' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${mot} 0 0 0 ${(.55 - mot / 2).toFixed(2)}' result='ma'/>`
    + `<feComposite in='ma' in2='s' operator='in' result='wash'/>`
    + `<feComposite in='wash' in2='ring' operator='arithmetic' k2='.75' k3='${ring}'/>`
    + `</filter><path d='M${blob.join("L")}Z' filter='url(#w)'/></svg>`;
}

function inkElement(el) {
  const w = el.offsetWidth, h = el.offsetHeight;
  if (!w || !h || el._inkSize === w + "x" + h) return;
  el._inkSize = w + "x" + h;
  const seed = hashSeed((el.id || "") + "|" + el.textContent);
  const weight = el.classList.contains("weekTip") ? 1.15 : el.classList.contains("chip") ? 1.3 : el.classList.contains("ghost") ? 1.4 : 1.8;
  const url = svg => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  el.style.setProperty("--ink-frame", url(inkFrame(w, h, seed, weight)));
  if (!el.classList.contains("weekTip")) {
    el.style.setProperty("--ink-fill", url(inkFill(w, h, seed)));
    el.style.setProperty("--ink-fill-soft", url(inkFill(w, h, seed, true)));
    // 键盘焦点:按钮自己的框 + 外面 FOCUS_RING px 再绕一圈,拼成一张图(CSS 在 :focus-visible 时换上,整张用强调色)
    const G = FOCUS_RING, W = w + 2 * G + 2 * INK_PAD, H = h + 2 * G + 2 * INK_PAD;
    el.style.setProperty("--ink-focus", url(`<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>`
      + `<path d='${inkFramePath(w + 2 * G, h + 2 * G, seed + 5, 1.3)}'/>`
      + `<path transform='translate(${G} ${G})' d='${inkFramePath(w, h, seed, weight)}'/></svg>`));
  }
  el.classList.add("inked");
}

/* ============ 纸边:餐巾纸和横线本的四条边不是尺子裁出来的 ============
   和手绘框一样按实际尺寸画一张 mask,挂在 --paper-edge 上(CSS 里纸挪到 ::before 显示)。
   每条边往外毛出 0~1.6px:几百像素一道的缓弯 + 几十像素的小波 + 逐点的毛刺,偶尔一个小缺口;
   四个角有的方、有的磨掉一点。都很浅,凑近了才看得出不齐 */
const EDGE_PAD = 2;   // 和 CSS 里 ::before 的 inset: -2px 对上
const EDGE_SEL = ".napkin, .card";

function paperEdge(w, h, seed) {
  const rnd = seededRand(seed), f = v => v.toFixed(1);
  const x0 = EDGE_PAD, y0 = EDGE_PAD, x1 = w + EDGE_PAD, y1 = h + EDGE_PAD;
  // 一条边:从 (ax,ay) 沿 (dx,dy) 走 L 像素,(nx,ny) 朝纸外;记下首尾的外扩量,拼角用
  function side(ax, ay, dx, dy, L, nx, ny) {
    const l1 = 160 + 260 * Math.abs(rnd()), l2 = 22 + 40 * Math.abs(rnd()), p1 = rnd() * 6, p2 = rnd() * 6;
    const nicks = [];   // [位置, 半宽, 深度]
    for (let k = Math.round(L / 320 * Math.abs(rnd()) + .3); k > 0; k--)
      nicks.push([L * Math.abs(rnd()), 3 + 5 * Math.abs(rnd()), .4 + .35 * Math.abs(rnd())]);
    const n = Math.max(2, Math.round(L / 3)), pts = [], offs = [];
    let fuzz = 0;
    for (let i = 0; i <= n; i++) {
      const t = L * i / n;
      fuzz = .5 * fuzz + .12 * rnd();   // 毛刺:相邻两点连着,不是锯齿
      let o = .75 + .4 * Math.sin(t / l1 * 6.28 + p1) + .2 * Math.sin(t / l2 * 6.28 + p2) + fuzz;
      for (const [c, r, dep] of nicks) o -= dep * Math.exp(-(((t - c) / r) ** 2));
      o = Math.min(1.6, Math.max(0, o));
      offs.push(o);
      pts.push([ax + dx * t + nx * o, ay + dy * t + ny * o]);
    }
    return { pts, a: offs[0], b: offs[n], nx, ny };
  }
  const sides = [
    side(x0, y0, 1, 0, w, 0, -1),    // 上
    side(x1, y0, 0, 1, h, 1, 0),     // 右
    side(x1, y1, -1, 0, w, 0, 1),    // 下
    side(x0, y1, 0, -1, h, -1, 0),   // 左
  ];
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const out = [];
  sides.forEach((s, i) => {
    // 角:前一条边收尾和这条边起头的外扩量合起来;k<1 就是角被磨掉一点
    const p = sides[(i + 3) % 4], k = .5 + .5 * Math.abs(rnd());
    out.push([corners[i][0] + (p.nx * p.b + s.nx * s.a) * k, corners[i][1] + (p.ny * p.b + s.ny * s.a) * k]);
    out.push(...s.pts);
  });
  const W = w + 2 * EDGE_PAD, H = h + 2 * EDGE_PAD;
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none'>`
    + `<path d='M${out.map(q => f(q[0]) + " " + f(q[1])).join("L")}Z'/></svg>`;
}

function edgeElement(el) {
  const w = el.offsetWidth, h = el.offsetHeight;
  if (!w || !h || el._inkSize === w + "x" + h) return;
  el._inkSize = w + "x" + h;
  const seed = hashSeed(el.querySelector(".boss")?.textContent || "napkin");   // 同一张纸每次毛边一样
  el.style.setProperty("--paper-edge", `url("data:image/svg+xml,${encodeURIComponent(paperEdge(w, h, seed))}")`);
  el.classList.add("edged");
}

/* 输入框选中时的框:和按钮同一支笔,画在输入框外面 6px 一圈。input 不能有伪元素,
   所以框挂在 .searchWrap 的 --q-frame 上,由 ::before 显示;宽跟输入框,高跟整行 */
const FOCUS_GAP = 6;   // 和 CSS 里 .searchWrap::before 的 -12px(= 6 + INK_PAD)对上
const FOCUS_SEL = ".searchWrap";

function focusFrame(wrap) {
  const w = wrap.querySelector("#q").offsetWidth, h = wrap.offsetHeight;
  if (!w || !h || wrap._inkSize === w + "x" + h) return;
  wrap._inkSize = w + "x" + h;
  const svg = inkFrame(w + 2 * FOCUS_GAP, h + 2 * FOCUS_GAP, hashSeed("q"), 1.4);
  wrap.style.setProperty("--q-frame", `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
  wrap.classList.add("inked");
}

// 按钮/气泡的框、输入框的框和纸边共用一套观察:尺寸一变(首次 observe 也算)就重画
const inkRO = new ResizeObserver(entries => entries.forEach(({ target: t }) =>
  (t.matches(EDGE_SEL) ? edgeElement : t.matches(FOCUS_SEL) ? focusFrame : inkElement)(t)));
function inkScan(node, fn) {
  if (node.nodeType !== 1) return;
  const sel = INK_SEL + ", " + EDGE_SEL + ", " + FOCUS_SEL;
  if (node.matches(sel)) fn(node);
  node.querySelectorAll(sel).forEach(fn);
}
inkScan(document.body, el => inkRO.observe(el));
new MutationObserver(ms => ms.forEach(m => {
  m.addedNodes.forEach(n => inkScan(n, el => inkRO.observe(el)));
  m.removedNodes.forEach(n => inkScan(n, el => inkRO.unobserve(el)));
})).observe(document.body, { childList: true, subtree: true });
