
/* ===== inlined app.js (V17, real backend API) ===== */
/* ============================================================================
 * fnos-hermes-agent · V17 Web UI
 * 真实后端 API 对接版（覆盖原 mock 逻辑）
 *
 * 所有函数位于全局作用域（无 IIFE），供 DOM 内联 onclick 调用。
 * API 前缀 BASE 由 <base href> / document.baseURI 推导；
 * 鉴权通过 GET /api/health 返回的 X-Monitor-Token 头传递。
 * ========================================================================== */

window.currentAgent = 'default';
window.currentSession = '';
window.currentTheme = 'auto';
window.activeBtn = null;
window.activePanel = null;
window.popup = null;

/* 本地兜底状态（设置项等少量 UI 状态，真实保存走 /api/config） */
window._state = PV.Store.load();

/* ── 运行时状态 ── */
var BASE = '';
var monitorToken = '';
var _cfg = { providers: [], active_provider: '', extensions: { toolsets:{}, mcp_servers:[], skills_dirs:[], persona:'default', memory:{enabled:true,char_limit:2200}, team:[], team_name:'' } };
var _sessions = [];
var _services = { gateway:false, dashboard:false };
var _chState = { defs:{}, channels:{}, current:null, filter:'all' };
// QR 扫码流程会话令牌：每次打开/关闭渠道弹窗或启动新的扫码流程时递增，
// 各渠道 chPoll* 轮询链捕获启动时的 seq，回调发现 seq 变化立即终止——
// 修复「点过 TG/企微扫码后，进微信仍在调企微/TG 接口」的轮询串扰 bug。
var _chQrSeq = 0;
var _connState = { list:[] };
var _msgState = { streaming:false, abortCtrl:null, ws:null };
var _persona = 'default';
var _personaPrompt = '';
var _pendingAttachments = [];
var _toolNative = null;          // /proxy/dashboard 原生工具集
var _skillLocal = [];            // /api/extensions/skills/local
var _skillNative = [];           // /proxy/dashboard/api/skills
var _selectedExpert = null;       // 当前选用的单专家（注入用，{id,name,prompt}）
var _settingsLoaded = false;
var _logStream = null;
var _logInited = false;

/* ============================ 多 Agent（专家）分组 ============================ */
/* _agents：每个 agent 对应左侧会话树的一个可折叠分组；默认分组 id='default'。
   专家被选中时，为其创建独立 agent（id='exp-<expertId>），会话归入该分组。 */
var _agents = [];
try { _agents = JSON.parse(localStorage.getItem('hermes_agents') || '[]'); } catch (e) { _agents = []; }
if (!_agents.some(function (a) { return a.id === 'default'; })) {
  _agents.unshift({ id: 'default', name: '默认主力助手', icon: '🤖', expertId: null });
}
function saveAgents() {
  try { localStorage.setItem('hermes_agents', JSON.stringify(_agents.map(function (a) { return { id: a.id, name: a.name, icon: a.icon, expertId: a.expertId }; }))); } catch (e) {}
  // 服务端持久化（Issue #7）：跨浏览器/清缓存不丢失角色分组
  if (_cfg && _cfg.extensions) { _cfg.extensions.agents = _agents.map(function (a) { return { id: a.id, name: a.name, icon: a.icon, expertId: a.expertId }; }); _saveConfigDebounced(); }
}
/* 防抖保存配置，避免每次会话/分组变动都打 POST */
var _saveTimer = null;
function _saveConfigDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function () { saveConfig(); }, 500);
}
function getAgent(id) { return _agents.find(function (a) { return a.id === id; }); }
function ensureAgent(id, props) {
  var a = getAgent(id);
  if (!a) { a = { id: id, name: (props && props.name) || id, icon: (props && props.icon) || '🤖', expertId: (props && props.expertId) || null }; _agents.push(a); saveAgents(); }
  return a;
}
/* 会话 → 所属 agent 的映射（持久化，专家会话刷新后仍归对应分组） */
var _sessionAgent = {};
/* 工具栏专家选择器当前 tab：'single' 单专家 | 'team' 专家团 */
var _expertPickerTab = 'single';
try { _sessionAgent = JSON.parse(localStorage.getItem('hermes_session_agent') || '{}'); } catch (e) { _sessionAgent = {}; }
function persistSessionAgent() {
  try { localStorage.setItem('hermes_session_agent', JSON.stringify(_sessionAgent)); } catch (e) {}
  // 服务端持久化（Issue #7）：会话→角色分组映射跨浏览器/清缓存不丢失
  if (_cfg && _cfg.extensions) { _cfg.extensions.session_agent = _sessionAgent; _saveConfigDebounced(); }
}
function setSessionAgent(sid, aid) { if (sid) { _sessionAgent[sid] = aid; persistSessionAgent(); } }

/* ============================ 基础工具 ============================ */
function $(s){ return document.querySelector(s); }
function $$(s){ return document.querySelectorAll(s); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function uid(){ return 'u'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

/* 轻量 toast（不再用 alert 阻塞） */
function toast(msg){
  var t = document.getElementById('__toast');
  if(!t){
    t = document.createElement('div');
    t.id = '__toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);max-width:80%;padding:10px 16px;border-radius:10px;background:rgba(20,24,32,.95);color:#e8eaed;font-size:13px;line-height:1.5;border:1px solid #2a2f3a;box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:99999;opacity:0;transition:opacity .2s;pointer-events:none;word-break:break-all';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(function(){ t.style.opacity = '0'; }, 2800);
}

/* ============================ API 基础 ============================ */
function _resolveBase(){
  try {
    var b = document.querySelector('base');
    var href = (b && b.getAttribute('href')) || document.baseURI || window.location.pathname;
    var path = String(href).split('?')[0].split('#')[0];
    if (/\/[^\/]+\.[a-zA-Z0-9]+$/.test(path)) path = path.replace(/\/[^\/]+\.[a-zA-Z0-9]+$/, '');
    return path.replace(/\/$/, '') || '';
  } catch(e){ return (window.location.pathname||'').replace(/\/$/,'') || ''; }
}
function apiUrl(p){ return BASE + p; }

function fetchToken(){
  return fetch(apiUrl('/api/health')).then(function(r){
    if(!r.ok) return null;
    return r.json();
  }).then(function(d){
    if(d && d.token) monitorToken = d.token;
    return d;
  }).catch(function(){ return null; });
}

/* 抛 HTTP 错误（网络 / 状态码） */
function api(path, method, body){
  method = method || 'GET';
  var headers = { 'Content-Type':'application/json' };
  if(monitorToken) headers['X-Monitor-Token'] = monitorToken;
  var opts = { method:method, headers:headers, cache:'no-store' };
  if(body) opts.body = JSON.stringify(body);
  return fetch(apiUrl(path), opts).then(function(r){
    if(!r.ok){
      return r.json().catch(function(){ return null; }).then(function(j){
        throw new Error((j && j.error) ? (j.error+' (HTTP '+r.status+')') : ('HTTP '+r.status));
      });
    }
    return r.json();
  });
}
/* 不抛逻辑错误，返回原始 JSON（便于读取 {ok:false,error}） */
function apiGet(path){ return api(path,'GET').catch(function(e){ return { ok:false, error:e.message }; }); }
function apiPost(path, body){ return api(path,'POST',body).catch(function(e){ return { ok:false, error:e.message }; }); }

/* ============================ Markdown 渲染 ============================ */
if(window.marked && window.marked.use){
  try {
    window.marked.use({
      renderer:{
        link: function(href, title, text){
          if(typeof href === 'object' && href !== null){ var tok=href; href=tok.href; title=tok.title; text=tok.text; }
          var safeHref = (href||'').replace(/"/g,'&quot;');
          var titleAttr = title ? ' title="'+String(title).replace(/"/g,'&quot;')+'"' : '';
          return '<a href="'+safeHref+'" target="_blank" rel="noopener noreferrer"'+titleAttr+'>'+text+'</a>';
        }
      }
    });
  } catch(e){}
}
if(window.DOMPurify){
  try {
    window.DOMPurify.addHook('afterSanitizeAttributes', function(node){
      if(node.tagName === 'A'){ node.setAttribute('target','_blank'); node.setAttribute('rel','noopener noreferrer'); }
    });
  } catch(e){}
}
function balanceMarkdown(text){
  var out = text;
  var fence = out.match(/```/g);
  if(fence && fence.length % 2 === 1) out += '\n```';
  var without = out.replace(/```[\s\S]*?```/g, '');
  var tick = (without.match(/`/g)||[]).length;
  if(tick % 2 === 1) out += '`';
  if((out.match(/\*\*/g)||[]).length % 2 === 1) out += '**';
  return out;
}
function preprocessMarkdown(text){
  if(!text) return text;
  // 网关/模型有时会返回「一行式 Markdown」：大段文字没有换行，列表也 inline。
  // 这里做保守预处理：在中文句末标点后插入段落换行，并把 "label：- item" 切为列表。
  // 1) 中文句末标点后接空格+中文，视为新段落开头
  text = text.replace(/([。！？；])\s+(?=[\u4e00-\u9fa5])/g, '$1\n');
  // 2) 冒号/全角冒号后立即跟 -，视为列表开始
  text = text.replace(/([:：])\s*-\s+/g, '$1\n- ');
  // 3) 对已开始的列表行，继续把后续 inline " - item" 拆成独立列表项
  text = text.split('\n').map(function(line){
    if(line.indexOf(' - ') === -1) return line;
    if(!/^\s*-\s/.test(line)) return line;
    var parts = line.split(' - ');
    if(parts.length < 3) return line;
    return parts.slice(0,2).join(' - ') + '\n- ' + parts.slice(2).join('\n- ');
  }).join('\n');
  return text;
}
function linkifyBareUrls(text){
  var placeholders = [], phIdx = 0;
  function protect(re){ return function(m){ var ph='\x00PH'+(phIdx++)+'\x00'; placeholders.push({ph:ph,val:m}); return ph; }; }
  var out = text.replace(/```[\s\S]*?```/g, protect());
  out = out.replace(/`[^`\n]+`/g, protect());
  var urlRe = /(?<!\]\()(?<!href=["'])(https?:\/\/[^\s<>"'`\x00-\x1f]+?)(?=[)）\]}。、，；！？\s]|$)/g;
  out = out.replace(urlRe, function(raw){
    var url=raw, trail='';
    var m=raw.match(/^(.+?)([)）\]}。、，；！？]+)$/);
    if(m){ url=m[1]; trail=m[2]; }
    url=url.replace(/[.,;:!\])}>]+$/,'');
    return '['+url+']('+url+')'+trail;
  });
  for(var i=placeholders.length-1;i>=0;i--){ out = out.split(placeholders[i].ph).join(placeholders[i].val); }
  return out;
}
function renderMarkdown(text, streaming){
  if(!window.marked) return escapeHtml(text||'');
  var src = streaming ? balanceMarkdown(text||'') : (text||'');
  src = src.replace(/\r/g,'');
  src = preprocessMarkdown(src);
  src = linkifyBareUrls(src);
  var html;
  try {
    // marked v13+ 默认返回 Promise，强制同步解析
    if(window.marked.parseSync){
      html = window.marked.parseSync(src, { breaks:true, gfm:true });
    } else {
      html = window.marked.parse(src, { breaks:true, gfm:true, async:false });
    }
  }
  catch(e){ html = escapeHtml(src); }
  html = window.DOMPurify ? window.DOMPurify.sanitize(html, { ADD_ATTR:['target'] }) : html;
  html = html.replace(/<a[^>]*href="mailto:[^"]*"[^>]*>(.*?)<\/a>/gi, '$1');
  if(BASE){
    html = html.replace(/(<img[^>]+src=")(\/(?:tmp|uploads|workspace|data)\/[^"]+)(")/gi, function(m,p,path,q){ return p+BASE+path+q; });
  }
  html = html.replace(/<table>/g,'<div class="table-wrap"><table>').replace(/<\/table>/g,'</table></div>');
  return html;
}
/* 旧版 mdToHtml 保留为简单兜底（非流式渲染时使用） */
function mdToHtml(s){
  return renderMarkdown(s, false);
}

/* ============================ 顶部按钮 ============================ */
function openNewWindow(){ window.open(window.location.href, '_blank'); }
function openGitHub(){ window.open('https://github.com/hermes-agent/fnos-hermes-agent','_blank'); }

/* ============================ 会话树（Rail） ============================ */
/* ============================ 多会话标签（浏览器式多开） ============================ */
/* _openTabs：已打开的会话标签 id 数组（有序）；_tabDrafts：各标签输入框草稿；_tabStreaming：流式状态 */
var _openTabs = [];
var _tabDrafts = {};
var _tabStreaming = {};
var _chatHTML = {};  // sid → chatBody.innerHTML 快照（流式后台继续时保留最新内容，切回时从缓存恢复）
try { _openTabs = JSON.parse(localStorage.getItem('hermes_open_tabs') || '[]'); } catch (e) { _openTabs = []; }
function persistTabs() { try { localStorage.setItem('hermes_open_tabs', JSON.stringify(_openTabs)); } catch (e) {} }

/* 渲染顶部标签栏 */
function renderSessionTabs() {
  var scroll = document.getElementById('tabsScroll');
  if (!scroll) return;
  var html = '';
  _openTabs.forEach(function (sid) {
    var s = _sessions.find(function (x) { return x.id === sid; });
    if (!s) return;
    var active = (sid === currentSession);
    var rawTitle = (s.title && s.title !== 'New Chat' && s.title !== '未命名会话') ? s.title : '新会话';
    var streaming = !!_tabStreaming[sid];
    html += '<div class="session-tab' + (active ? ' active' : '') + (streaming ? ' streaming' : '') + '" title="' + esc(rawTitle) + '" onclick="switchTab(\'' + esc(sid) + '\')">' +
      '<span class="tab-dot"></span>' +
      '<span class="tab-title">' + esc(rawTitle) + '</span>' +
      '<span class="tab-close" onclick="event.stopPropagation();closeTab(\'' + esc(sid) + '\')" title="关闭标签">×</span>' +
      '</div>';
  });
  scroll.innerHTML = html;
  var activeEl = scroll.querySelector('.session-tab.active');
  if (activeEl && activeEl.scrollIntoView) { try { activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
  var btn = document.getElementById('tabNewBtn');
  if (btn) btn.style.display = 'inline-flex';
}

/* 保存/恢复指定标签的输入框草稿 */
function saveDraft(sid) {
  var ta = document.getElementById('chatInput');
  if (ta && sid) _tabDrafts[sid] = ta.value;
}
function restoreDraft(sid) {
  var ta = document.getElementById('chatInput');
  if (!ta) return;
  ta.value = _tabDrafts[sid] || '';
  try { autoResize(ta); } catch (e) {}
  var send = document.getElementById('sendBtn');
  if (send) send.disabled = !ta.value.trim();
}

/* 打开（或激活）一个会话标签 */
function openTab(sid) {
  if (!sid) return;
  if (_openTabs.indexOf(sid) === -1) { _openTabs.push(sid); persistTabs(); }
  switchTab(sid);
}

/* 切换激活标签：流式后台继续（并行多会话）。切换前保存当前 chatBody → _chatHTML[currentSession]，切回时仍优先用缓存（流式最新） */
function switchTab(sid) {
  if (!sid || sid === currentSession) return;
  var body = document.getElementById('chatBody');
  if (body && currentSession) _chatHTML[currentSession] = body.innerHTML;
  currentSession = sid;
  renderSessionTabs();
  renderRail(); updateHeader();
  restoreDraft(sid);
  _syncModelBtn();
  if (body) {
    var cached = _chatHTML[sid];
    if (cached) {
      // 命中内存快照：立即恢复渲染（0 延迟），后台静默拉取最新消息覆盖，避免显示过期内容
      body.innerHTML = cached;
      body.scrollTop = body.scrollHeight;
      hideScrollBtn();
      loadSessionMessages(sid, true);
    } else {
      body.innerHTML = '<div class="system-tip">加载中…</div>';
      loadSessionMessages(sid);
    }
  }
}
// 从 _cfg 中查找当前 active provider 的默认模型名（/status 与模型按钮兜底共用）
function _getActiveModelName(){
  var ap = _cfg.active_provider;
  if(!ap) return '自动';
  var p = (_cfg.providers||[]).find(function(p){ return (p.name||p.id)===ap; });
  if(!p) return '自动';
  var model = p.model || '';
  if(model) return model;
  var models = p.models || [];
  var def = models.find(function(m){ return m.default===true; });
  if(def) return def.id || def.name || '';
  var en = models.find(function(m){ return m.enabled!==false; });
  return en ? (en.id || en.name || '') : '自动';
}
function _syncModelBtn(){
  var bm=document.getElementById('btnModel'); if(!bm) return;
  // 移除旧徽章
  var oldBadge = bm.querySelector('.model-badge'); if(oldBadge) oldBadge.remove();
  var sm=_getSessionModel();
  if(sm){
    var mName=(typeof sm==='object'&&sm.model)?sm.model:sm;
    bm.setAttribute('data-tip','模型: '+mName); bm.classList.add('active');
    // 添加小徽章显示模型名
    var badge=document.createElement('span');
    badge.className='model-badge';
    badge.textContent=mName.length>8?mName.slice(0,8)+'…':mName;
    bm.appendChild(badge);
  } else {
    // 无会话级选择时，兜底显示全局默认模型（修复：切换 Provider/模型后首页与按钮无反映）
    var globalModel = _getActiveModelName();
    var globalProv = _cfg.active_provider || '';
    if(globalModel && globalModel !== '自动'){
      bm.setAttribute('data-tip', (globalProv?globalProv+' · ':'')+globalModel);
      bm.classList.add('active');
      var label = globalProv ? globalProv.slice(0,4)+'…' : globalModel;
      var badge2 = document.createElement('span');
      badge2.className='model-badge';
      badge2.textContent = label.length>8 ? label.slice(0,8)+'…' : label;
      bm.appendChild(badge2);
    } else {
      bm.setAttribute('data-tip','选择模型'); bm.classList.remove('active');
    }
  }
}

/* 关闭一个会话标签（会话本身保留在左侧树）；流式中允许关闭（后台流式继续，不影响其他会话） */
function closeTab(sid) {
  var i = _openTabs.indexOf(sid);
  if (i === -1) return;
  // 流式允许后台继续：仅清理 UI 状态（如果当前 tab 被关闭，需要 abort 它的流式，因为没有可见 DOM 了）
  if (_tabStreaming[sid]) {
    if (currentSession === sid) {
      try { fetch(apiUrl('/api/chat/stop'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Monitor-Token': monitorToken || '' }, body: JSON.stringify({ session_id: sid }) }).catch(function () {}); } catch (e) {}
      if (_msgState.ws) { try { _msgState.ws.close(1000, 'tab closed'); } catch (e) {} _msgState.ws = null; }
      if (_msgState.abortCtrl) try { _msgState.abortCtrl.abort(); } catch (e) {}
      _msgState.streaming = false; _msgState.abortCtrl = null;
    }
    _tabStreaming[sid] = false;
  }
  _openTabs.splice(i, 1); persistTabs();
  delete _tabDrafts[sid];
  if (currentSession === sid) {
    currentSession = _openTabs.length ? _openTabs[Math.min(i, _openTabs.length - 1)] : '';
    if (currentSession) {
      renderRail(); updateHeader();
      restoreDraft(currentSession);
      loadSessionMessages(currentSession);
      _syncModelBtn();
    } else {
      var body = document.getElementById('chatBody');
      if (body) body.innerHTML = '<div class="system-tip">没有打开的会话，点击右上角 + 新建</div>';
      updateHeader();
      _syncModelBtn();
    }
  }
  renderSessionTabs(); renderRail();
}

/* 新建会话并打开为标签 */
function newTab() {
  // 团队模式或工作流启用时，新会话强制归入 team 分组
  var ext = _cfg.extensions || {};
  var teamActive = ext.team_enabled && ext.team && ext.team.length;
  var wfActive = ext.workflow && ext.workflow.enabled && ext.workflow.steps && ext.workflow.steps.length;
  var aid = (teamActive || wfActive) ? 'team' : (currentAgent || 'default');
  if (teamActive || wfActive) { ensureAgent('team', { name: ext.team_name || ext.workflow.name || '我的团队', icon: wfActive ? '⚙️' : '👥' }); currentAgent = 'team'; }
  fetch(apiUrl('/api/sessions'), { method: 'POST', headers: monitorToken ? { 'X-Monitor-Token': monitorToken } : {} })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      _sessions.unshift(s);
      currentSession = s.id;
      setSessionAgent(s.id, aid);
      _applyPendingModel(s.id);
      _openTabs.push(s.id); persistTabs();
      var ta = document.getElementById('chatInput'); if (ta) ta.value = '';
      renderSessionTabs(); renderRail(); updateHeader();
      if (window.innerWidth <= 768) closeRailDrawer();
      var body = document.getElementById('chatBody');
      if (body) body.innerHTML = '<div class="system-tip">新会话已创建</div>';
    })
    .catch(function () { toast('创建会话失败'); });
}

/* 与后端会话列表同步标签（删除会话后清理、首次加载默认打开一个） */
function syncTabs() {
  var valid = _sessions.map(function (s) { return s.id; });
  _openTabs = _openTabs.filter(function (sid) { return valid.indexOf(sid) !== -1; });
  if (!_openTabs.length && _sessions.length) { _openTabs.push(_sessions[0].id); }
  persistTabs();
  if (currentSession && valid.indexOf(currentSession) === -1) {
    currentSession = _openTabs.length ? _openTabs[0] : '';
  }
  renderSessionTabs();
}

/* 同步标签栏可见性：多会话按钮强制开启 > 移动端始终显示 > 桌面端仅 rail 折叠时显示 */
var _multiTabsForced = false;
function toggleSessionTabsBar(){
  _multiTabsForced = !_multiTabsForced;
  var btn=document.getElementById('multiTabsBtn');
  if(btn) btn.classList.toggle('active', _multiTabsForced);
  syncSessionTabsVisibility();
}
function syncSessionTabsVisibility() {
  var tabs = document.querySelector('.page-container .session-tabs');
  if (!tabs) return;
  var rail = document.getElementById('chatRail');
  if (!rail) return;
  if (_multiTabsForced) {
    tabs.classList.add('visible');  // 多会话按钮强制开启
  } else if (window.innerWidth <= 768) {
    tabs.classList.add('visible');  // 移动端：始终显示
  } else if (rail.classList.contains('hidden')) {
    tabs.classList.add('visible');  // 桌面端：仅 rail 折叠时显示
  } else {
    tabs.classList.remove('visible');
  }
}

function loadSessions(){
  return fetch(apiUrl('/api/sessions'), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(d){
      _sessions = (d && d.sessions) || [];
      if(!currentSession && _sessions.length){ currentSession = _sessions[0].id; }
      else if(currentSession && !_sessions.some(function(s){ return s.id===currentSession; })){ currentSession = _sessions.length?_sessions[0].id:''; }
      syncTabs();
      renderRail(); updateHeader();
      _syncModelBtn();
      if(currentSession) loadSessionMessages(currentSession);
    })
    .catch(function(){ toast('加载会话失败，无法连接后端'); renderRail(); });
}
function fmtDateTime(ts){
  if(!ts) return '';
  var d = new Date(ts);
  if(isNaN(d.getTime())) return '';
  var pad = function(n){ return (n<10?'0':'')+n; };
  var now = new Date();
  var hm = pad(d.getHours())+':'+pad(d.getMinutes());
  var sameDay = d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
  if(sameDay) return '今天 '+hm;
  var y = new Date(now); y.setDate(now.getDate()-1);
  var isYest = d.getFullYear()===y.getFullYear() && d.getMonth()===y.getMonth() && d.getDate()===y.getDate();
  if(isYest) return '昨天 '+hm;
  return (d.getMonth()+1)+'月'+d.getDate()+'日 '+hm;
}
function renderRail(){
  var el = document.getElementById('railScroll');
  if(!el) return;
  // 一次性清理 v0.20.66 期间 localStorage 存的旧 'true' 值（让默认折叠生效）
  if (!_state._railOpenCleaned) {
    try {
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('hermes_rail_open_') === 0) localStorage.removeItem(keys[i]);
      }
      _state._railOpenCleaned = true;
      try { localStorage.setItem('hermes_ui_flags', JSON.stringify({ railOpenCleaned: true })); } catch(e){}
    } catch(e){ _state._railOpenCleaned = true; }
  }
  if(!_sessions.length){
    el.innerHTML = '<div class="empty-state">暂无会话，点击右上角 + 新建。</div>';
    return;
  }
  var html = '';
  _agents.forEach(function(agent){
    var isActiveAgent = (currentAgent === agent.id);
    // 默认所有 agent 分组都【折叠】，用户点击才展开。
    // 仅当 localStorage 显式记录为 'true' 才展开（v0.20.66 期间的旧值已被上面清理）
    var open = (localStorage.getItem('hermes_rail_open_'+agent.id) === 'true');
    // 归属映射若指向不存在的 agent（如本地存储被部分清理），回退到 default，避免会话丢失
    var sessIds = _sessions.filter(function(s){
      var aid = _sessionAgent[s.id] || 'default';
      if(aid !== 'default' && !getAgent(aid)) aid = 'default';
      return aid === agent.id;
    }).map(function(s){ return s.id; });
    html += '<div class="agent-group"><div class="agent-row'+(open?' expanded':'')+(isActiveAgent?' active':'')+'" onclick="toggleAgent(\''+esc(agent.id)+'\')">'+
      '<span class="chevron">▶</span><span class="avatar">'+esc(agent.icon||'🤖')+'</span>'+
      '<span class="info"><div class="name">'+esc(agent.name)+'</div><div class="desc">'+(isActiveAgent&&agent.id==='default'?'默认主力助手':'')+'</div></span>'+
      (agent.id!=='default' ? '<span class="agent-del" title="删除该分组" onclick="deleteAgentGroup(\''+esc(agent.id)+'\',event)">×</span>' : '')+
      '</div>'+
      '<div class="session-list'+(open?' open':'')+'" id="sess-'+esc(agent.id)+'">';
    if(sessIds.length){
      html += sessIds.map(function(sid){
        var s = _sessions.find(function(x){ return x.id===sid; });
        if(!s) return '';
        var sa = (sid===currentSession) ? 'active' : '';
        var streaming = !!_tabStreaming[sid];
        var rawTitle = (s.title && s.title!=='New Chat' && s.title!=='未命名会话') ? s.title : '';
        var title = rawTitle || '新会话';
        var meta = fmtDateTime(s.updated_at) + (s.message_count ? ' · '+s.message_count+' 条' : '');
        return '<div class="session-item '+sa+(streaming?' streaming':'')+'" onclick="switchSession(\''+esc(agent.id)+'\',\''+esc(s.id)+'\',event)">'+
          '<span class="dot'+(streaming?' streaming':'')+'"></span>'+
          '<span class="si-body"><span class="title">'+esc(title)+'</span>'+(meta?'<span class="meta">'+esc(meta)+'</span>':'')+'</span>'+
          '<span class="del" onclick="delSession(\''+esc(agent.id)+'\',\''+esc(s.id)+'\',event)">×</span></div>';
      }).join('');
    } else {
      html += '<div class="empty-sess">暂无会话</div>';
    }
    html += '</div></div>';
  });
  // ── 通道会话分组（微信/Telegram 等）──
  var chGroups = _channelSessions || {};
  var chIds = Object.keys(chGroups).filter(function(k){ return k !== 'api_server'; });
  if(chIds.length){
    html += '<div class="rail-divider" style="margin:12px 0 8px;border-top:1px solid var(--border);padding-top:8px;font-size:11px;color:var(--muted);letter-spacing:1px">通道会话</div>';
    chIds.forEach(function(chId){
      var sessions = chGroups[chId];
      var def = (_chState.defs && _chState.defs[chId]) || {};
      var chName = def.name || chId;
      var chIcon = def.icon || '📨';
      var open = (localStorage.getItem('hermes_rail_open_ch_'+chId) === 'true');
      html += '<div class="agent-group"><div class="agent-row'+(open?' expanded':'')+'" onclick="toggleChannelGroup(\''+esc(chId)+'\')">' +
        '<span class="chevron">▶</span><span class="avatar">'+esc(chIcon)+'</span>'+
        '<span class="info"><div class="name">'+esc(chName)+'</div><div class="desc">'+sessions.length+' 个会话</div></span></div>'+
        '<div class="session-list'+(open?' open':'')+'" id="sess-ch-'+esc(chId)+'">';
      if(sessions.length){
        html += sessions.slice(0,20).map(function(s){
          var title = (s.title && s.title!=='未命名会话') ? s.title : '新会话';
          var meta = s.model ? esc(s.model) : '';
          return '<div class="session-item" onclick="openChannelSession(\''+esc(chId)+'\',\''+esc(s.id)+'\')">' +
            '<span class="dot"></span>'+
            '<span class="si-body"><span class="title">'+esc(title)+'</span>'+(meta?'<span class="meta">'+meta+'</span>':'')+'</span>'+
            '</div>';
        }).join('');
      } else {
        html += '<div class="empty-sess">暂无会话</div>';
      }
      html += '</div></div>';
    });
  }
  el.innerHTML = html;
}
var _channelSessions = null;
function fetchChannelSessions(){
  apiGet('/api/channel-sessions').then(function(res){
    if(res && res.ok && res.groups){ _channelSessions = res.groups; renderRail(); }
  }).catch(function(){});
}
function toggleChannelGroup(chId){
  var list = document.getElementById('sess-ch-'+chId);
  if(list){ var open = list.classList.toggle('open'); localStorage.setItem('hermes_rail_open_ch_'+chId, open ? 'true' : 'false'); }
}
function openChannelSession(chId, sessionId){
  // 通道会话：直接在 WEBUI 聊天窗口加载消息（从 Dashboard API 拉取）
  var def = (_chState.defs && _chState.defs[chId]) || {};
  var chName = def.name || chId;
  // 切换到聊天页
  switchPage('chat');
  // 更新标题
  var titleEl = document.getElementById('chatTitle');
  var subEl = document.getElementById('chatSubtitle');
  if(titleEl) titleEl.textContent = chName + ' 通道会话';
  if(subEl) subEl.textContent = '加载中…';
  // 显示 loading
  var body = document.getElementById('chatBody');
  if(body) body.innerHTML = '<div class="system-tip">正在加载 '+esc(chName)+' 通道会话消息…</div>';
  // 拉取消息
  apiGet('/api/channel-sessions/'+encodeURIComponent(sessionId)+'/messages').then(function(res){
    if(!res || !res.ok || !res.messages || !res.messages.length){
      if(body) body.innerHTML = '<div class="system-tip">该通道会话暂无消息记录'+(res&&res.error?' ('+esc(res.error)+')':'')+'</div>';
      if(subEl) subEl.textContent = chName + ' · 0 条消息';
      return;
    }
    var msgs = res.messages;
    if(subEl) subEl.textContent = chName + ' · ' + msgs.length + ' 条消息' + (res.title ? ' · ' + res.title : '');
    // 渲染消息到聊天区域
    var html = '<div class="system-tip" style="background:var(--accent);color:#fff;opacity:.9">📨 '+esc(chName)+' 通道会话（只读） · '+msgs.length+' 条消息</div>';
    msgs.forEach(function(m){
      var isUser = (m.role === 'user' || m.role === 'human');
      var cls = isUser ? 'user' : 'assistant';
      var label = isUser ? '你' : ('Hermes' + (m.model ? ' · '+m.model : ''));
      var time = m.timestamp ? fmtDateTime(m.timestamp) : '';
      var content = m.content || '';
      // 简单 Markdown 渲染（代码块 + 换行）
      var rendered = esc(content).replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>').replace(/\n/g, '<br>');
      html += '<div class="msg '+cls+'"><div class="msg-bubble"><div class="md-text">'+rendered+'</div></div><div class="msg-meta">'+esc(label)+' · '+esc(time)+'</div></div>';
    });
    if(body){ body.innerHTML = html; body.scrollTop = body.scrollHeight; }
  }).catch(function(e){
    if(body) body.innerHTML = '<div class="system-tip">加载失败：'+esc(e.message||'网络错误')+'</div>';
  });
}
function toggleAgent(id){
  currentAgent = id;
  var list = document.getElementById('sess-'+id);
  if(list){ var open = list.classList.toggle('open'); localStorage.setItem('hermes_rail_open_'+id, open ? 'true' : 'false'); }
}
function switchSession(aid, sid, e){
  if(e) e.stopPropagation();
  currentAgent = aid; 
  if(aid) setSessionAgent(sid, aid);
  openTab(sid);
  if(window.innerWidth<=768) closeRailDrawer();
}
/* 删除 Agent 分组（非 default）：分组下的会话移回「默认主力助手」，不删除会话本身 */
function deleteAgentGroup(aid, e){
  if(e) e.stopPropagation();
  if(!aid || aid === 'default') return;
  var a = getAgent(aid);
  var sessIds = _sessions.filter(function(s){
    var x = _sessionAgent[s.id] || 'default';
    if(x !== 'default' && !getAgent(x)) x = 'default';
    return x === aid;
  }).map(function(s){ return s.id; });
  var msg = '确定删除分组「' + (a ? a.name : aid) + '」？';
  if(sessIds.length) msg += '\n该分组下的 ' + sessIds.length + ' 个会话将移动到「默认主力助手」。';
  if(!confirm(msg)) return;
  // 会话移回默认分组
  sessIds.forEach(function(sid){ _sessionAgent[sid] = 'default'; });
  persistSessionAgent();
  _agents = _agents.filter(function(x){ return x.id !== aid; });
  saveAgents();
  try{ localStorage.removeItem('hermes_rail_open_' + aid); }catch(err){}
  if(currentAgent === aid) currentAgent = 'default';
  renderRail(); renderSessionTabs(); updateHeader();
  toast('已删除分组');
}
function delSession(aid, sid, e){
  if(e) e.stopPropagation();
  if(!confirm('确定删除该会话？')) return;
  fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)), { method:'DELETE', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(){
      _sessions = _sessions.filter(function(s){ return s.id!==sid; });
      delete _sessionAgent[sid]; persistSessionAgent();
      var ti = _openTabs.indexOf(sid);
      if(ti!==-1){ _openTabs.splice(ti,1); persistTabs(); }
      delete _tabDrafts[sid]; delete _tabStreaming[sid]; delete _chatHTML[sid];
      if(currentSession===sid) currentSession = _openTabs.length?_openTabs[0]:(_sessions.length?_sessions[0].id:'');
      renderSessionTabs(); renderRail(); updateHeader();
      if(currentSession) loadSessionMessages(currentSession);
      else { var b = document.getElementById('chatBody'); if(b) b.innerHTML = '<div class="system-tip">没有打开的会话，点击右上角 + 新建</div>'; }
    })
    .catch(function(){ toast('删除会话失败'); });
}
function newSession(){
  newTab();
}
function loadSessionMessages(sid, silent){
  var body = document.getElementById('chatBody');
  if(!body) return;
  if(silent){ var h = _chatHTML[sid]; if(h) body.innerHTML = h; }  // 静默刷新前确保已有内容（幂等兜底）
  fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ if(!r.ok) throw new Error('load'); return r.json(); })
    .then(function(s){
      var msgs = s.messages || [];
      if(!msgs.length){ body.innerHTML = '<div class="system-tip">这是一个空会话，开始聊天吧～</div>'; return; }
      body.innerHTML = msgs.map(function(m){ return msgHTML(m); }).join('');
      _chatHTML[sid] = body.innerHTML;  // 回写快照缓存，下次切换 0 延迟
      body.scrollTop = body.scrollHeight;
      hideScrollBtn();
    })
    .catch(function(){ body.innerHTML = '<div class="system-tip">加载消息失败，请确认后端已连接。</div>'; });
}
function splitContent(content){
  if(typeof content === 'string') return { text: content, images: [] };
  if(Array.isArray(content)){
    var text = '', images = [];
    content.forEach(function(p){
      if(!p) return;
      if(p.type === 'text' && p.text) text += (text ? '\n' : '') + p.text;
      else if(p.type === 'image_url' && p.image_url && p.image_url.url) images.push(p.image_url.url);
    });
    return { text: text, images: images };
  }
  if(content && typeof content === 'object'){
    return { text: content.text || '', images: Array.isArray(content.images) ? content.images : [] };
  }
  return { text: '', images: [] };
}
function msgHTML(m){
  var parts = splitContent(m.content);
  var text = parts.text, imgs = parts.images;
  var imgHtml = imgStackHTML(imgs);
  if(m.role === 'user'){
    return '<div class="msg user"><div class="msg-bubble">'+escapeHtml(text).replace(/\n/g,'<br>')+imgHtml+'</div><div class="msg-meta">你 · '+fmtDateTime(m.ts||m.created_at||Date.now())+'</div></div>';
  }
  var toolsHtml = toolCallsHTML(m.tools);
  var msgText = esc(text).replace(/'/g,"\\'").replace(/\n/g,' ');
  var actionsHtml = '<div class="msg-actions">' +
    '<button class="msg-act-btn" onclick="speakMsg(this)" title="语音播放"><svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>播放</button>' +
    '<button class="msg-act-btn" onclick="quoteMsg(this)" title="引用回复"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>引用</button>' +
    '<button class="msg-act-btn" onclick="forkMsg(this)" title="Fork 新话题"><svg viewBox="0 0 24 24"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><path d="M12 12v3"/></svg>Fork</button>' +
    '</div>';
  return '<div class="msg assistant" data-content="'+esc(text).replace(/"/g,'&quot;').replace(/\n/g,'&#10;')+'"><div class="msg-bubble">'+renderMarkdown(text)+imgHtml+toolsHtml+'</div>'+actionsHtml+'<div class="msg-meta">Hermes · '+fmtDateTime(m.ts||m.created_at||Date.now())+'</div></div>';
}

/* ── 聊天图片：卡片式堆叠 + 灯箱大图（点击任意卡片查看，←/→ 上下页切换，Esc 关闭）── */
var _lbImgs = [], _lbIdx = 0;
function chatImgSrc(u){
  if(!u) return '';
  if(/^(https?:|data:|blob:)/i.test(u)) return u;
  return BASE + u; // 相对路径（/tmp /uploads /workspace /data）补 BASE 前缀
}
function imgStackHTML(imgs){
  if(!imgs || !imgs.length) return '';
  var list = imgs.map(chatImgSrc);
  var arg = esc(JSON.stringify(list));
  if(list.length === 1){
    return '<img src="'+esc(list[0])+'" alt="图片" loading="lazy" style="max-width:220px;max-height:220px;border-radius:var(--radius-md);display:block;margin-top:6px;cursor:zoom-in;object-fit:cover" onclick="openImgLightbox(\''+arg+'\',0)">';
  }
  var n = Math.min(list.length, 5);
  var off = 9;
  var html = '<div class="img-stack" style="width:'+(150+(n-1)*off)+'px;height:'+(150+(n-1)*off)+'px" onclick="openImgLightbox(\''+arg+'\',0)" title="点击查看 '+list.length+' 张图片">';
  for(var i=0;i<n;i++){
    html += '<img class="img-stack-item" src="'+esc(list[i])+'" alt="图片'+(i+1)+'" loading="lazy" style="left:'+(i*off)+'px;top:'+(i*off)+'px;z-index:'+(i+1)+'">';
  }
  html += '<span style="position:absolute;left:'+((n-1)*off+156)+'px;top:'+((n-1)*off+60)+'px;font-size:11px;color:var(--text);background:var(--accent);border-radius:12px;padding:3px 10px;font-weight:600;z-index:'+(n+1)+'">'+list.length+' 张 ▸</span></div>';
  return html;
}
function openImgLightbox(jsonList, idx){
  var arr = [];
  try { arr = JSON.parse(jsonList); } catch(e){ return; }
  if(!arr.length) return;
  _lbImgs = arr;
  _lbIdx = Math.max(0, Math.min(idx||0, arr.length-1));
  renderImgLightbox();
}
function renderImgLightbox(){
  var o = document.getElementById('imgLightbox');
  if(!o){
    o = document.createElement('div');
    o.id = 'imgLightbox';
    o.innerHTML = '<div class="lb-bg" onclick="closeImgLightbox()"></div>' +
      '<button class="lb-btn lb-close" onclick="closeImgLightbox()" title="关闭 (Esc)">✕</button>' +
      '<button class="lb-btn lb-prev" onclick="imgLbNav(-1)" title="上一张 (←)">‹</button>' +
      '<button class="lb-btn lb-next" onclick="imgLbNav(1)" title="下一张 (→)">›</button>' +
      '<div class="lb-count"></div>' +
      '<img class="lb-img" alt="大图预览">';
    document.body.appendChild(o);
  }
  o.querySelector('.lb-img').src = _lbImgs[_lbIdx];
  o.querySelector('.lb-count').textContent = (_lbIdx+1) + ' / ' + _lbImgs.length;
  o.style.display = 'flex';
  // 预载相邻图片，翻页不闪烁
  [1,-1].forEach(function(d){
    var i = _lbIdx + d;
    if(i>=0 && i<_lbImgs.length){ var im = new Image(); im.src = _lbImgs[i]; }
  });
}
function imgLbNav(d){
  if(!_lbImgs.length) return;
  _lbIdx = (_lbIdx + d + _lbImgs.length) % _lbImgs.length;
  renderImgLightbox();
}
function closeImgLightbox(){
  var o = document.getElementById('imgLightbox');
  if(o) o.style.display = 'none';
}
document.addEventListener('keydown', function(e){
  var o = document.getElementById('imgLightbox');
  if(!o || o.style.display==='none') return;
  if(e.key==='Escape') closeImgLightbox();
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp') imgLbNav(-1);
  else if(e.key==='ArrowRight'||e.key==='ArrowDown') imgLbNav(1);
});

/* 工具调用映射（对齐 Hermes 消息网关规范：terminal=💻 / web=🔍 / execute_code=🐍 等） */
var TOOL_EMOJI = {
  terminal: '💻', execute_code: '🐍', run_code: '🐍',
  read_file: '📄', write_file: '📝', edit_file: '✏️',
  search_files: '🔎', web: '🔍', web_search: '🔍', web_extract: '📄',
  delegate_task: '🤖', delegation: '🤖', session_search: '💬',
  browser: '🌐', image_gen: '🎨', file_ops: '📂', memory: '🧠',
  shell: '💻', bash: '💻', cmd: '💻',
};
var TOOL_NAME_ZH = {
  terminal: '终端命令', execute_code: '执行代码', run_code: '执行代码',
  read_file: '读取文件', write_file: '写入文件', edit_file: '编辑文件',
  search_files: '搜索文件', web: '网页搜索', web_search: '网页搜索', web_extract: '网页提取',
  delegate_task: '委派任务', delegation: '委派任务', session_search: '会话搜索',
  browser: '浏览器', image_gen: '图像生成', file_ops: '文件操作', memory: '记忆',
  shell: '终端命令', bash: '终端命令', cmd: '终端命令',
};
function toolCardHTML(tp){
  if(!tp) return '';
  // 技能调用：渲染为紧凑 chip，而不是展开的工具卡片（Issue #9）
  if(tp.skill || (tp.tool && /skill/i.test(tp.tool))){
    var sName = tp.toolZh || tp.name || tp.tool || '技能';
    return '<span class="skill-invoke-chip">🧩 '+esc(sName)+'</span>';
  }
  var emoji = tp.emoji || TOOL_EMOJI[tp.tool] || '🔧';
  var name = tp.toolZh || TOOL_NAME_ZH[tp.tool] || tp.tool || '工具';
  var status = tp.status || 'done';
  var running = !(status==='done'||status==='completed'||status==='finish'||status==='finished');
  var label = tp.label || tp.command || tp.summary || '';
  var result = tp.result || '';
  var idAttr = tp.toolCallId ? (' data-tid="'+esc(tp.toolCallId)+'"') : '';
  // 已完成的历史工具卡片默认折叠，节省聊天空间（Issue #8）
  var collapsed = !running;
  var html = '<div class="tool-call'+(running?' running':'')+(collapsed?' collapsed':'')+'"'+idAttr+'>'+
    '<div class="tool-head" onclick="this.parentNode.classList.toggle(\'collapsed\')">'+
      '<span class="tool-icon">'+emoji+'</span>'+
      '<span class="tool-name">'+esc(name)+'</span>'+
      '<span class="tool-status '+(running?'running':'done')+'">'+(running?'执行中…':'已完成')+'</span>'+
    '</div>';
  if(label){
    html += '<div class="tool-cmd"><span class="tool-cmd-label">命令</span>'+escapeHtml(label)+'</div>';
  }
  if(result){
    html += '<div class="tool-out"><span class="tool-cmd-label">结果</span>'+escapeHtml(result)+'</div>';
  }
  return html+'</div>';
}
/* 历史/流式的工具集合统一包成「紧凑摘要条 + 可展开列表」（Issue #8） */
function toolCallsHTML(tools){
  if(!tools || !tools.length) return '';
  return '<div class="tool-calls" data-collapsed="true"><div class="tool-summary" onclick="toggleToolCalls(this.parentNode)">'+
    '<span class="tc-ico">🛠</span><span class="tc-text">已调用 '+tools.length+' 个工具</span><span class="tc-toggle">展开 ▾</span></div>'+
    '<div class="tool-list">'+tools.map(toolCardHTML).join('')+'</div></div>';
}
function toggleToolCalls(box){
  if(!box) return;
  var collapsed = box.getAttribute('data-collapsed')==='true';
  box.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
  var tog = box.querySelector('.tc-toggle');
  if(tog) tog.textContent = collapsed ? '收起 ▴' : '展开 ▾';
}
/* 回到底部按钮（Issue #10） */
function scrollChatToBottom(){
  var b=document.getElementById('chatBody');
  if(b){ b.scrollTop=b.scrollHeight; var btn=document.getElementById('scrollBottomBtn'); if(btn) btn.style.display='none'; }
}
function hideScrollBtn(){
  var btn=document.getElementById('scrollBottomBtn'); if(btn) btn.style.display='none';
}

/* ============================ 工作区面板 ============================ */
function toggleWorkspace(){
  var panel=document.getElementById('workspacePanel');
  if(!panel) return;
  panel.classList.toggle('open');
  var btn=document.getElementById('wsPanelToggle');
  if(btn) btn.classList.toggle('active', panel.classList.contains('open'));
  if(panel.classList.contains('open')){
    var activeTab=panel.querySelector('.ws-tab.active');
    if(activeTab && activeTab.textContent.includes('文件')) fmRefresh();
  }
}
function wsSwitchTab(btn, key){
  document.querySelectorAll('.ws-tab').forEach(function(t){ t.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('.ws-pane').forEach(function(p){ p.classList.remove('active'); });
  var pane=document.getElementById('ws-'+key); if(pane) pane.classList.add('active');
  if(key==='files') fmRefresh();
}

/* ============================ 文件管理器 ============================ */
var _fmCwd = '';
var _fmEditPath = '';
function fmRefresh(){
  var path = _fmCwd || '';
  apiGet('/api/files?path='+encodeURIComponent(path)).then(function(res){
    if(!res || !res.ok){ document.getElementById('fmList').innerHTML='<div class="empty-state">'+(res?res.error:'加载失败')+'</div>'; return; }
    _fmCwd = res.path;
    document.getElementById('fmPath').textContent = res.path;
    var el=document.getElementById('fmList');
    if(!res.items.length){ el.innerHTML='<div class="empty-state">空目录</div>'; return; }
    el.innerHTML = res.items.map(function(item){
      var icon = item.type==='dir' ? '📁' : (item.name.match(/\.(js|ts|py|sh|json|yaml|yml|md|txt|csv|html|htm)$/i) ? '📄' : '📃');
      var size = item.type==='file' ? (item.size>1024 ? (item.size/1024).toFixed(1)+'KB' : item.size+'B') : '';
      var act = item.type==='dir' ? '' :
        '<span class="ws-file-act" title="下载" onclick="event.stopPropagation();fmDownload(\''+esc(item.path).replace(/'/g,"\\'")+'\')">⬇</span>'+
        '<span class="ws-file-act" title="附加到对话" onclick="event.stopPropagation();fmAttachPath(\''+esc(item.path).replace(/'/g,"\\'")+'\')">📎</span>'+
        '<span class="ws-file-del" title="删除" onclick="event.stopPropagation();fmDelete(\''+esc(item.path).replace(/'/g,"\\'")+'\')">\ud83d\uddd1</span>';
      return '<div class="ws-file-item" onclick="'+(item.type==='dir'?'fmOpenDir':'fmOpenFile')+'(\''+esc(item.path).replace(/'/g,"\\'")+'\')">' +
        '<span class="ws-file-icon">'+icon+'</span>' +
        '<span class="ws-file-name">'+esc(item.name)+'</span>' +
        '<span class="ws-file-size">'+size+'</span>' +
        act +
        '</div>';
    }).join('');
  }).catch(function(e){ document.getElementById('fmList').innerHTML='<div class="empty-state">网络错误</div>'; });
}
function fmOpenDir(path){ _fmCwd=path; fmRefresh(); }
function fmUp(){
  if(!_fmCwd || _fmCwd==='/') return;
  var parent=_fmCwd.substring(0,_fmCwd.lastIndexOf('/'))||'/';
  _fmCwd=parent; fmRefresh();
}
function fmOpenFile(path){
  _fmEditPath=path;
  document.getElementById('fmPreviewName').textContent=path.split('/').pop();
  document.getElementById('fmPreview').style.display='flex';
  var ext=(path.split('.').pop()||'').toLowerCase();
  var body=document.getElementById('fmPreviewBody');
  var editor=document.getElementById('fmEditor');
  var saveBtn=document.getElementById('fmSaveBtn');
  var enc=encodeURIComponent(path);
  // 图片：直接内联预览
  if(['jpg','jpeg','png','gif','webp','svg','bmp','ico'].indexOf(ext)>=0){
    editor.style.display='none'; body.style.display='block';
    body.innerHTML='<img src="'+apiUrl('/api/preview?path=')+enc+'" alt="" style="max-width:100%;max-height:calc(100% - 8px);object-fit:contain;border-radius:6px">';
    saveBtn.style.display='none';
    return;
  }
  // PDF / HTML：浏览器原生内联预览
  if(ext==='pdf'||ext==='html'||ext==='htm'){
    editor.style.display='none'; body.style.display='block';
    body.innerHTML='<iframe src="'+apiUrl('/api/preview?path=')+enc+'"></iframe>';
    saveBtn.style.display='none';
    return;
  }
  // Office：服务端转 HTML 预览（docx/xlsx/pptx）
  if(ext==='docx'||ext==='xlsx'||ext==='pptx'){
    editor.style.display='none'; body.style.display='block';
    body.innerHTML='<iframe src="'+apiUrl('/api/preview/office?path=')+enc+'"></iframe>';
    saveBtn.style.display='none';
    return;
  }
  // 文本类：优先走 /api/preview（8MB 上限，含 md/csv 富渲染）
  var isText = ['txt','md','markdown','csv','json','yaml','yml','xml','log','ini','conf',
    'js','mjs','cjs','ts','tsx','jsx','py','sh','bash','c','h','cpp','cc','hpp','java','go','rs','rb','php','css','sql'].indexOf(ext)>=0;
  if(isText){
    apiGet('/api/preview?path='+enc).then(function(res){
      if(!res || !res.ok){ toast(res?res.error:'读取失败','error'); return; }
      if(ext==='md'||ext==='markdown'){
        editor.style.display='none'; body.style.display='block';
        body.innerHTML='<div class="md-text">'+renderMarkdown(res.content||'')+'</div>';
        saveBtn.style.display='none';
        return;
      }
      if(ext==='csv'){
        editor.style.display='none'; body.style.display='block';
        body.innerHTML=csvToTable(res.content||'');
        saveBtn.style.display='none';
        return;
      }
      editor.style.display='block'; body.style.display='none';
      saveBtn.style.display='';
      editor.value=res.content||'';
    }).catch(function(){ toast('预览失败','error'); });
    return;
  }
  // 未知类型：回退旧接口（textarea + 保存）
  editor.style.display='block'; body.style.display='none'; saveBtn.style.display='';
  apiGet('/api/files/read?path='+enc).then(function(res){
    if(!res || !res.ok){ toast(res?res.error:'读取失败','error'); return; }
    editor.value=res.content;
  });
}
function csvToTable(csv){
  var rows=String(csv||'').split(/\r?\n/).filter(function(l,i,arr){ return !(i===arr.length-1 && !l.trim()); });
  if(!rows.length) return '<div class="empty-state">空 CSV</div>';
  var cells=rows.map(function(r){ return r.split(','); });
  var w=Math.max.apply(null,cells.map(function(c){ return c.length; }));
  var html='<div class="table-wrap"><table><thead><tr>';
  for(var i=0;i<w;i++) html+='<th>'+esc(cells[0][i]||'')+'</th>';
  html+='</tr></thead><tbody>';
  for(var r=1;r<cells.length;r++){
    html+='<tr>';
    for(var j=0;j<w;j++) html+='<td>'+esc(cells[r][j]||'')+'</td>';
    html+='</tr>';
  }
  return html+'</tbody></table></div>';
}
function fmDownload(path){
  var p=path||_fmEditPath;
  if(!p) return;
  var name=p.split('/').pop()||'file';
  var hdrs={}; if(monitorToken) hdrs['X-Monitor-Token']=monitorToken;
  fetch(apiUrl('/api/download?path='+encodeURIComponent(p)),{headers:hdrs})
    .then(function(r){ if(!r.ok) throw new Error(String(r.status)); return r.blob(); })
    .then(function(blob){
      var a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=name;
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); try{ document.body.removeChild(a); }catch(e){} }, 2000);
    })
    .catch(function(){ toast('下载失败','error'); });
}
function fmAttachPath(path){
  var name=path.split('/').pop()||'file';
  // 以 /api/download?path= 形式引用，后端 normalizeMessage 时解析回真实路径，Agent 可直接读取分析
  _pendingAttachments.push({ url:'/api/download?path='+encodeURIComponent(path)+'&name='+encodeURIComponent(name), type:'application/octet-stream', name:name });
  toast('📎 已附加到对话：'+name);
  renderAttachChips();
  autoResize(document.getElementById('chatInput'));
}
function fmAttach(){ fmAttachPath(_fmEditPath); }
function fmSaveFile(){
  if(!_fmEditPath) return;
  var content=document.getElementById('fmEditor').value;
  fetch(apiUrl('/api/files/write'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:_fmEditPath,content:content})})
    .then(function(r){return r.json();}).then(function(res){ if(res.ok) toast('✅ 已保存'); else toast(res.error||'保存失败','error'); });
}
function fmClosePreview(){ document.getElementById('fmPreview').style.display='none'; _fmEditPath=''; }
function fmNewFile(){
  var name=prompt('新建文件名：');
  if(!name) return;
  var path=_fmCwd+'/'+name;
  fetch(apiUrl('/api/files/write'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:path,content:''})})
    .then(function(r){return r.json();}).then(function(res){ if(res.ok){ toast('✅ 已创建'); fmRefresh(); } else toast(res.error||'创建失败','error'); });
}
function fmNewDir(){
  var name=prompt('新建目录名：');
  if(!name) return;
  var path=_fmCwd+'/'+name;
  fetch(apiUrl('/api/files/mkdir'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:path})})
    .then(function(r){return r.json();}).then(function(res){ if(res.ok){ toast('✅ 目录已创建'); fmRefresh(); } else toast(res.error||'创建失败','error'); });
}
function fmDelete(path){
  if(!confirm('确定删除？\n'+path)) return;
  fetch(apiUrl('/api/files?path='+encodeURIComponent(path)),{method:'DELETE'})
    .then(function(r){return r.json();}).then(function(res){ if(res.ok){ toast('🗑 已删除'); fmRefresh(); } else toast(res.error||'删除失败','error'); });
}

/* ============================ 终端管理（PTY：二进制帧 + ANSI 流式渲染） ============================ */
var _termWs = null;
var _termDecoder = new TextDecoder('utf-8');
var _termRuns = [];           // [{t:文本, b:粗体, f:前景, bg:背景}] 已渲染片段
var _termStyle = { b:0, f:'', bg:'' }; // 当前 SGR 状态（跨 chunk 保持）
var _termEsc = '';            // 未完成的转义序列
var _termCols = 0, _termRows = 0;
var _termHist = []; var _termHistIdx = -1;
var _ANSI_COLORS={0:'#000',1:'#cd0000',2:'#00cd00',3:'#cdcd00',4:'#0000ee',5:'#cd00cd',6:'#00cdcd',7:'#e5e5e5',8:'#7f7f7f',9:'#ff0000',10:'#00ff00',11:'#ffff00',12:'#5c5cff',13:'#ff00ff',14:'#00ffff',15:'#ffffff'};
function ansi256Color(n){
  n=parseInt(n,10)||0;
  if(n<16) return _ANSI_COLORS[n]||'#fff';
  if(n<232){
    n-=16;
    var r=Math.floor(n/36),g=Math.floor((n%36)/6),b=n%6;
    function cv(v){ v=Math.round(v*255/5); var h=v.toString(16); return h.length<2?'0'+h:h; }
    return '#'+cv(r)+cv(g)+cv(b);
  }
  var v=8+(n-232)*10; var h=v.toString(16); if(h.length<2)h='0'+h;
  return '#'+h+h+h;
}
function applySGR(st, params){
  if(!params || !params.length) params=['0'];
  var i=0;
  while(i<params.length){
    var p=params[i];
    if(!p){ i++; continue; }
    var num=parseInt(p,10);
    if(isNaN(num)){ i++; continue; }
    if(num===0){ st.b=0; st.f=''; st.bg=''; }
    else if(num===1){ st.b=1; }
    else if(num===2){ st.b=0; }
    else if(num===22){ st.b=0; }
    else if(num>=30&&num<=37){ st.f=_ANSI_COLORS[num-30]; }
    else if(num===39){ st.f=''; }
    else if(num>=90&&num<=97){ st.f=_ANSI_COLORS[num-90]; }
    else if(num>=40&&num<=47){ st.bg=_ANSI_COLORS[num-40]; }
    else if(num===49){ st.bg=''; }
    else if(num>=100&&num<=107){ st.bg=_ANSI_COLORS[num-100]; }
    else if(num===38||num===48){
      var mode=params[i+1], key=num===38?'f':'bg';
      if(mode==='5'){ st[key]=ansi256Color(params[i+2]); i+=3; }
      else if(mode==='2'){ st[key]='rgb('+params[i+2]+','+params[i+3]+','+params[i+4]+')'; i+=5; }
      else { i++; }
    }
    i++;
  }
}
function termAppend(raw){
  var el=document.getElementById('termOutput');
  if(!el) return;
  var s=_termEsc+String(raw||''); _termEsc='';
  var buf=''; var i=0, L=s.length;
  function commit(){
    if(!buf) return;
    _termRuns.push({ t:buf, b:_termStyle.b, f:_termStyle.f, bg:_termStyle.bg });
    if(_termRuns.length>20000) _termRuns.splice(0,_termRuns.length-20000); // 防内存膨胀
    buf='';
  }
  while(i<L){
    var c=s.charAt(i);
    if(c==='\x1b'){
      if(i+1>=L){ _termEsc=s.slice(i); break; }
      var nxt=s.charAt(i+1);
      if(nxt==='['){
        var mm=s.slice(i+2).match(/^([0-9;?]*)([@-~])/);
        if(mm){
          if(mm[2]==='m'){ commit(); applySGR(_termStyle, mm[1]?mm[1].split(';'):[]); }
          else if(mm[2]==='J'){ commit(); _termRuns.length=0; el.innerHTML=''; } // 清屏
          else if(mm[2]==='K'){ commit(); } // 清行：忽略（轻量终端）
          i+=2+mm[0].length;
          continue;
        }
        _termEsc=s.slice(i); break; // 不完整 CSI，等下个 chunk
      }
      if(nxt===']'){
        var oe=s.indexOf('\x07', i+2);
        if(oe<0){ _termEsc=s.slice(i); break; } // OSC 未结束
        i=oe+1; continue;
      }
      if(nxt==='('||nxt===')'||nxt==='>'||nxt==='='){
        if(i+2>=L){ _termEsc=s.slice(i); break; }
        i+=3; continue;
      }
      if(s.length-i<2){ _termEsc=s.slice(i); break; }
      i+=2; continue;
    }
    if(c==='\r'||c==='\n'){
      if(c==='\r' && s.charAt(i+1)==='\n') i++;
      buf+='\n'; i++; continue;
    }
    var j=i;
    while(j<L){ var ch=s.charAt(j); if(ch==='\x1b'||ch==='\r'||ch==='\n') break; j++; }
    buf+=s.slice(i,j); i=j;
  }
  commit();
  // 增量渲染：只补新片段
  var html='';
  var last=_termRuns.length;
  if(_termAppendMark===undefined || _termAppendMark>last){ _termAppendMark=0; el.innerHTML=''; }
  for(var k=_termAppendMark;k<last;k++){
    var r=_termRuns[k];
    var css='';
    if(r.b) css+='font-weight:bold;';
    if(r.f) css+='color:'+r.f+';';
    if(r.bg) css+='background-color:'+r.bg+';';
    html+=(css?'<span style="'+css+'">':'')+esc(r.t)+(css?'</span>':'');
  }
  _termAppendMark=last;
  if(html) el.insertAdjacentHTML('beforeend', html);
  // 未上滚时跟随底部
  if(el.scrollTop+el.clientHeight>=el.scrollHeight-60) el.scrollTop=el.scrollHeight;
}
var _termAppendMark=0;
function termConnect(){
  if(_termWs && _termWs.readyState<=1) return;
  var proto = location.protocol==='https:'?'wss:':'ws:';
  var url = proto+'//'+location.host+(window._basePath||'')+'/api/terminal/ws?token='+(monitorToken||'')+'&cwd='+encodeURIComponent(_fmCwd||'');
  document.getElementById('termStatus').textContent='连接中…';
  _termWs = new WebSocket(url);
  _termWs.binaryType='arraybuffer';
  _termWs.onopen=function(){
    document.getElementById('termStatus').textContent='✅ 已连接';
    termResize(true);
  };
  _termWs.onmessage=function(e){
    if(typeof e.data==='string'){
      try{
        var data=JSON.parse(e.data);
        if(data.type==='output'){ termAppend(data.data); }
        else if(data.type==='exit'){ document.getElementById('termStatus').textContent='已退出 (code:'+data.code+')'; _termWs=null; }
      }catch(err){ termAppend(e.data); }
      return;
    }
    // PTY 原始二进制帧：流式 UTF-8 解码（跨 chunk 多字节字符不丢）
    termAppend(_termDecoder.decode(new Uint8Array(e.data), {stream:true}));
  };
  _termWs.onclose=function(){ document.getElementById('termStatus').textContent='已断开'; _termWs=null; };
  _termWs.onerror=function(){ document.getElementById('termStatus').textContent='连接失败'; };
}
function termDisconnect(){
  if(_termWs){ _termWs.close(); _termWs=null; }
  document.getElementById('termStatus').textContent='未连接';
}
function termResize(force){
  var el=document.getElementById('termOutput');
  if(!el) return;
  var cols=Math.max(20, Math.floor(el.clientWidth/7.5));
  var rows=Math.max(5, Math.floor(el.clientHeight/16));
  if(!force && cols===_termCols && rows===_termRows) return;
  _termCols=cols; _termRows=rows;
  if(_termWs && _termWs.readyState===1) _termWs.send(JSON.stringify({type:'resize', cols:cols, rows:rows}));
}
window.addEventListener('resize', function(){ termResize(false); });
function termClear(){
  _termRuns.length=0; _termAppendMark=0; _termStyle={b:0,f:'',bg:''};
  var el=document.getElementById('termOutput'); if(el) el.innerHTML='';
}
function termKeydown(e){
  var input=document.getElementById('termInput');
  if(e.key==='Enter'){ termSend(); e.preventDefault(); return; }
  if(e.key==='ArrowUp'){
    e.preventDefault();
    if(!_termHist.length) return;
    if(_termHistIdx<0) _termHistIdx=_termHist.length-1;
    else if(_termHistIdx>0) _termHistIdx--;
    input.value=_termHist[_termHistIdx];
    return;
  }
  if(e.key==='ArrowDown'){
    e.preventDefault();
    if(_termHistIdx>=0){
      _termHistIdx++;
      if(_termHistIdx>=_termHist.length){ _termHistIdx=-1; input.value=''; }
      else input.value=_termHist[_termHistIdx];
    }
    return;
  }
}
function termSend(){
  var input=document.getElementById('termInput');
  var cmd=input.value;
  input.value='';
  if(!_termWs||_termWs.readyState!==1){ toast('终端未连接','error'); return; }
  _termWs.send(JSON.stringify({type:'input',data:cmd+'\n'}));
  // PTY 下 bash 自行回显，无需本地回显（否则会重复显示）
  if(cmd.trim()){ _termHist.push(cmd); if(_termHist.length>100) _termHist.shift(); _termHistIdx=-1; }
}

/* ============================ 消息操作：语音播放 / 引用 / Fork ============================ */
var _currentQuote = null;
var _speakingBtn = null;

function speakMsg(btn){
  var msgEl = btn.closest('.msg');
  var text = msgEl ? (msgEl.getAttribute('data-content') || msgEl.querySelector('.md-text').textContent) : '';
  if(!text){ toast('无可播放内容','error'); return; }
  // 解码 HTML 实体
  var tmp = document.createElement('textarea'); tmp.innerHTML = text; text = tmp.value;
  // 去除 Markdown 标记
  text = text.replace(/[#*`~\[\]()]/g,'').replace(/\n+/g,'。');
  if(!window.speechSynthesis){ toast('浏览器不支持语音播放','error'); return; }
  // 如果正在播放，停止
  if(_speakingBtn === btn){ window.speechSynthesis.cancel(); btn.classList.remove('speaking'); btn.innerHTML='<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>播放'; _speakingBtn=null; return; }
  window.speechSynthesis.cancel();
  if(_speakingBtn){ _speakingBtn.classList.remove('speaking'); _speakingBtn.innerHTML='<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>播放'; }
  var utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'zh-CN'; utter.rate = 1.0;
  utter.onend = function(){ btn.classList.remove('speaking'); btn.innerHTML='<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>播放'; _speakingBtn=null; };
  utter.onerror = utter.onend;
  btn.classList.add('speaking');
  btn.innerHTML='<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>停止';
  _speakingBtn = btn;
  window.speechSynthesis.speak(utter);
}

function quoteMsg(btn){
  var msgEl = btn.closest('.msg');
  var text = msgEl ? (msgEl.getAttribute('data-content') || msgEl.querySelector('.md-text').textContent) : '';
  if(!text){ toast('无可引用内容','error'); return; }
  var tmp = document.createElement('textarea'); tmp.innerHTML = text; text = tmp.value;
  _currentQuote = text.length > 500 ? text.slice(0, 500) + '…' : text;
  var preview = document.getElementById('quotePreview');
  var previewText = document.getElementById('quotePreviewText');
  if(preview && previewText){
    previewText.textContent = '引用: ' + (_currentQuote.length > 80 ? _currentQuote.slice(0, 80) + '…' : _currentQuote);
    preview.classList.add('show');
  }
  var input = document.getElementById('chatInput');
  if(input) input.focus();
  toast('💬 已引用，输入问题后发送');
}
function clearQuote(){
  _currentQuote = null;
  var preview = document.getElementById('quotePreview');
  if(preview) preview.classList.remove('show');
}

function forkMsg(btn){
  var msgEl = btn.closest('.msg');
  var text = msgEl ? (msgEl.getAttribute('data-content') || msgEl.querySelector('.md-text').textContent) : '';
  if(!text){ toast('无可 Fork 内容','error'); return; }
  var tmp = document.createElement('textarea'); tmp.innerHTML = text; text = tmp.value;
  var forkContent = text.length > 800 ? text.slice(0, 800) + '…' : text;
  // 创建新会话并注入 fork 上下文
  fetch(apiUrl('/api/sessions'), { method:'POST', headers:monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(s){
      _sessions.unshift(s);
      currentSession = s.id;
      setSessionAgent(s.id, currentAgent || 'default');
      _applyPendingModel(s.id);
      _openTabs.push(s.id); persistTabs();
      renderSessionTabs(); renderRail(); updateHeader();
      var body = document.getElementById('chatBody');
      if(body){
        body.innerHTML = '<div class="system-tip">🍴 Fork 新话题（基于上一条回复）</div>' +
          '<div class="msg assistant"><div class="msg-bubble"><div class="quote-block"><div class="quote-label">FORK 来源</div>' + escapeHtml(forkContent) + '</div></div><div class="msg-meta">Fork 上下文 · ' + fmtDateTime(Date.now()) + '</div></div>';
      }
      // 设置标题
      var titleEl = document.getElementById('chatTitle');
      if(titleEl) titleEl.textContent = 'branch: ' + (forkContent.slice(0, 20) || '新话题');
      toast('🍴 已 Fork 为新话题，请继续提问');
      var input = document.getElementById('chatInput');
      if(input) input.focus();
    }).catch(function(){ toast('Fork 失败','error'); });
}

/* ============================ 多 Agent 圆桌讨论 ============================ */
var _rtState = { active:false, agents:[], rounds:2, currentRound:0, history:[], sessionId:null };

function openRoundtable(){
  if(!_profilesLoaded){ fetchProfiles(function(){ openRoundtable(); }); toast('加载 Agent 列表…'); return; }
  var agents = _profiles.length ? _profiles : [{id:'default',name:'默认助手',emoji:'🤖'}];
  var html = '<div class="modal-overlay" id="rtOverlay" onclick="if(event.target===this)closeRoundtable()">' +
    '<div class="modal" style="max-width:500px">' +
    '<div class="modal-head"><h3>🎙️ 多 Agent 圆桌讨论</h3><button class="modal-close" onclick="closeRoundtable()">×</button></div>' +
    '<div class="modal-body" style="padding:16px">' +
    '<p style="font-size:13px;color:var(--text2);margin-bottom:12px">选择 2 个或以上的 Agent，它们将在同一对话中轮流发言、互相讨论、最终给出综合方案。</p>' +
    '<div style="font-size:13px;font-weight:600;margin-bottom:6px">参与讨论的 Agent（点击选择）</div>' +
    '<div class="rt-agent-pick" id="rtAgentPick">' +
    agents.map(function(p){ return '<div class="rt-agent-chip" data-id="'+esc(p.id)+'" onclick="this.classList.toggle(\'selected\')"><span class="rt-emoji">'+(p.emoji||'🤖')+'</span>'+esc(p.name||p.id)+'</div>'; }).join('') +
    '</div>' +
    '<div class="rt-round-config"><label>讨论轮数：</label><select id="rtRounds"><option value="1">1 轮（各发言一次）</option><option value="2" selected>2 轮（深入讨论）</option><option value="3">3 轮（充分辩论）</option></select></div>' +
    '<div style="font-size:12px;color:var(--text3);margin-top:8px">💡 提示：每轮中各 Agent 会看到其他 Agent 的发言，并基于此进行回应、补充或反驳。</div>' +
    '</div>' +
    '<div class="modal-foot" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px">' +
    '<button class="btn" onclick="closeRoundtable()">取消</button>' +
    '<button class="btn primary" onclick="startRoundtable()">🚀 开始讨论</button>' +
    '</div></div></div>';
  var div=document.createElement('div'); div.innerHTML=html; document.body.appendChild(div.firstChild);
}
function closeRoundtable(){ var el=document.getElementById('rtOverlay'); if(el) el.remove(); }

function startRoundtable(){
  var chips = document.querySelectorAll('#rtAgentPick .rt-agent-chip.selected');
  if(chips.length < 2){ toast('请至少选择 2 个 Agent','error'); return; }
  var agents = [];
  chips.forEach(function(c){
    var id = c.getAttribute('data-id');
    var p = _profiles.find(function(x){ return x.id===id; });
    agents.push({ id:id, name:(p&&p.name)||id, emoji:(p&&p.emoji)||'🤖', prompt:(p&&p.prompt)||'', model:(p&&p.model)||'' });
  });
  var rounds = parseInt(document.getElementById('rtRounds').value) || 2;
  closeRoundtable();
  // 创建新会话
  fetch(apiUrl('/api/sessions'), { method:'POST', headers:monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(s){
      _rtState = { active:true, agents:agents, rounds:rounds, currentRound:0, history:[], sessionId:s.id };
      _sessions.unshift(s); currentSession = s.id;
      setSessionAgent(s.id, 'team');
      _applyPendingModel(s.id);
      _openTabs.push(s.id); persistTabs();
      renderSessionTabs(); renderRail();
      switchPage('chat');
      var titleEl=document.getElementById('chatTitle'); if(titleEl) titleEl.textContent='🎙️ 圆桌: '+agents.map(function(a){return a.name;}).join(' + ');
      var subEl=document.getElementById('chatSubtitle'); if(subEl) subEl.textContent=agents.length+' 位 Agent · '+rounds+' 轮讨论';
      var body=document.getElementById('chatBody');
      if(body){
        body.innerHTML='<div class="system-tip">🎙️ 圆桌讨论已开启：'+agents.map(function(a){return a.emoji+' '+a.name;}).join('、')+' · 共 '+rounds+' 轮</div>' +
          '<div class="rt-divider">请提出议题，各 Agent 将轮流发言讨论</div>';
      }
      toast('🎙️ 圆桌讨论已就绪，请提出议题');
    }).catch(function(){ toast('创建圆桌会话失败','error'); });
}

/* 圆桌模式下的发送：用户提问后各 Agent 轮流发言 */
function rtSend(userText){
  var body=document.getElementById('chatBody'); if(!body) return;
  // 显示用户消息
  var userDiv=document.createElement('div'); userDiv.className='msg user';
  userDiv.innerHTML='<div class="msg-bubble">'+escapeHtml(userText).replace(/\n/g,'<br>')+'</div><div class="msg-meta">你 · '+fmtDateTime(Date.now())+'</div>';
  body.appendChild(userDiv); body.scrollTop=body.scrollHeight;
  _rtState.history.push({ role:'user', name:'用户', content:userText });
  _rtState.currentRound = 0;
  rtNextRound();
}

function rtNextRound(){
  _rtState.currentRound++;
  if(_rtState.currentRound > _rtState.rounds){
    // 所有轮次结束，让最后一个 Agent 做总结
    rtSummarize();
    return;
  }
  var body=document.getElementById('chatBody');
  var divider=document.createElement('div'); divider.className='rt-divider';
  divider.textContent='第 '+_rtState.currentRound+' / '+_rtState.rounds+' 轮';
  body.appendChild(divider); body.scrollTop=body.scrollHeight;
  rtAgentSpeak(0);
}

function rtAgentSpeak(idx){
  var agents=_rtState.agents;
  if(idx >= agents.length){
    // 本轮结束，进入下一轮
    setTimeout(rtNextRound, 500);
    return;
  }
  var agent=agents[idx];
  var body=document.getElementById('chatBody');
  // 显示“正在发言”状态
  var statusDiv=document.createElement('div'); statusDiv.className='rt-status'; statusDiv.id='rtStatus';
  statusDiv.innerHTML='<span class="rt-pulse"></span>'+agent.emoji+' '+esc(agent.name)+' 正在发言…';
  body.appendChild(statusDiv); body.scrollTop=body.scrollHeight;

  // 构建 system prompt
  var sys = '【圆桌讨论模式】\n' +
    '你正在参加一场多智能体圆桌讨论。参与者有：' + agents.map(function(a){return a.emoji+a.name;}).join('、') + '。\n' +
    '你的身份是：' + agent.emoji + ' ' + agent.name + '。\n' +
    (agent.prompt ? '你的角色设定：' + agent.prompt + '\n' : '') +
    '规则：\n' +
    '1. 请基于你的专业角度发言，回应其他人的观点。\n' +
    '2. 可以赞同、补充、反驳其他 Agent 的意见。\n' +
    '3. 发言简洁有力，每次不超过 300 字。\n' +
    '4. 如果是最后一轮，请给出你的最终结论和建议。';

  // 构建上下文消息
  var contextMsg = '以下是目前的讨论记录：\n';
  _rtState.history.forEach(function(h){
    contextMsg += '【' + h.name + '】: ' + h.content + '\n\n';
  });
  contextMsg += '现在请你（' + agent.name + '）发言。';

  // 创建消息气泡
  var asst=document.createElement('div'); asst.className='msg assistant rt-agent';
  asst.innerHTML='<div class="rt-speaker"><span class="rt-sp-emoji">'+agent.emoji+'</span>'+esc(agent.name)+'</div>' +
    '<div class="msg-bubble"><div class="md-text"><span class="cursor-blink">|</span></div></div>' +
    '<div class="msg-meta">'+esc(agent.name)+' · '+fmtDateTime(Date.now())+'</div>';
  body.appendChild(asst); body.scrollTop=body.scrollHeight;
  var mdEl=asst.querySelector('.md-text');
  var fullText='';

  streamChat({
    session_id: _rtState.sessionId,
    message: contextMsg,
    system: sys,
    model: agent.model || undefined
  }, {
    onDelta: function(d){ fullText+=d; mdEl.innerHTML=renderMarkdown(fullText,true); body.scrollTop=body.scrollHeight; },
    onTool: function(){},
    onInfo: function(){},
    onError: function(err){ mdEl.innerHTML='<span class="error-text">⚠ '+esc(err)+'</span>'; rtAfterAgent(idx); },
    onDone: function(){
      mdEl.innerHTML=renderMarkdown(fullText);
      _rtState.history.push({ role:'assistant', name:agent.name, emoji:agent.emoji, content:fullText });
      rtAfterAgent(idx);
    }
  });
}

function rtAfterAgent(idx){
  var st=document.getElementById('rtStatus'); if(st) st.remove();
  setTimeout(function(){ rtAgentSpeak(idx+1); }, 600);
}

function rtSummarize(){
  var body=document.getElementById('chatBody');
  var divider=document.createElement('div'); divider.className='rt-divider';
  divider.textContent='📝 综合总结';
  body.appendChild(divider); body.scrollTop=body.scrollHeight;

  var statusDiv=document.createElement('div'); statusDiv.className='rt-status'; statusDiv.id='rtStatus';
  statusDiv.innerHTML='<span class="rt-pulse"></span>📝 正在生成综合方案…';
  body.appendChild(statusDiv); body.scrollTop=body.scrollHeight;

  var summaryMsg='以下是完整的圆桌讨论记录：\n';
  _rtState.history.forEach(function(h){ summaryMsg+='【'+h.name+'】: '+h.content+'\n\n'; });
  summaryMsg+='请作为主持人，综合以上所有 Agent 的讨论，给出最终的综合方案。包括：\n1. 各方核心观点摘要\n2. 共识与分歧\n3. 最终推荐方案\n4. 注意事项';

  var asst=document.createElement('div'); asst.className='msg assistant rt-agent';
  asst.innerHTML='<div class="rt-speaker"><span class="rt-sp-emoji">📝</span>主持人 · 综合总结</div>' +
    '<div class="msg-bubble" style="border-left-color:#10b981"><div class="md-text"><span class="cursor-blink">|</span></div></div>' +
    '<div class="msg-meta">综合方案 · '+fmtDateTime(Date.now())+'</div>';
  body.appendChild(asst); body.scrollTop=body.scrollHeight;
  var mdEl=asst.querySelector('.md-text');
  var fullText='';

  streamChat({
    session_id: _rtState.sessionId,
    message: summaryMsg,
    system: '你是圆桌讨论的主持人，负责综合所有参与者的发言给出最终方案。请客观、全面、结构化地总结。'
  }, {
    onDelta: function(d){ fullText+=d; mdEl.innerHTML=renderMarkdown(fullText,true); body.scrollTop=body.scrollHeight; },
    onTool: function(){},
    onInfo: function(){},
    onError: function(err){ mdEl.innerHTML='<span class="error-text">⚠ '+esc(err)+'</span>'; var st=document.getElementById('rtStatus'); if(st) st.remove(); },
    onDone: function(){
      mdEl.innerHTML=renderMarkdown(fullText);
      var st=document.getElementById('rtStatus'); if(st) st.remove();
      var done=document.createElement('div'); done.className='rt-divider';
      done.textContent='✅ 圆桌讨论结束';
      body.appendChild(done); body.scrollTop=body.scrollHeight;
      _rtState.history.push({ role:'assistant', name:'主持人', content:fullText });
      toast('✅ 圆桌讨论完成');
      loadSessions();
    }
  });
}

/* ============================ 新建会话弹窗 ============================ */
function openNewSessionModal(){
  // 获取 profiles 和 models 列表
  var html='<div class="modal-overlay new-session-modal" id="newSessionOverlay" onclick="if(event.target===this)closeNewSessionModal()">' +
    '<div class="modal" style="max-width:440px">' +
    '<div class="modal-head"><h3>新建会话</h3><button class="modal-close" onclick="closeNewSessionModal()">\u00d7</button></div>' +
    '<div class="modal-body">' +
    '<div class="field"><label>Agent / Profile</label><select id="nsAgent"><option value="default">默认主力助手</option></select></div>' +
    '<div class="field"><label>模型</label><select id="nsModel"><option value="">默认模型</option></select></div>' +
    '<div class="field"><label>工作区文件夹</label><input type="text" id="nsWorkspace" placeholder="留空使用默认工作区" value=""></div>' +
    '</div>' +
    '<div class="modal-foot" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px">' +
    '<button class="ov-actbtn" onclick="closeNewSessionModal()">取消</button>' +
    '<button class="ov-actbtn primary" onclick="createNewSession()">创建</button>' +
    '</div></div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
  // 加载 profiles
  apiGet('/api/profiles').then(function(res){
    if(res && res.ok && res.profiles){
      var sel=document.getElementById('nsAgent');
      res.profiles.forEach(function(p){
        if(p.id!=='default') sel.innerHTML+='<option value="'+esc(p.id)+'">'+esc(p.emoji||'')+' '+esc(p.name||p.id)+'</option>';
      });
    }
  });
  // 加载模型
  apiGet('/api/config').then(function(res){
    if(res && res.providers){
      var sel=document.getElementById('nsModel');
      res.providers.forEach(function(p){
        if(p.models && p.models.length){
          p.models.forEach(function(m){ sel.innerHTML+='<option value="'+esc(m)+'">'+esc(m)+'</option>'; });
        } else if(p.model){
          sel.innerHTML+='<option value="'+esc(p.model)+'">'+esc(p.model)+'</option>';
        }
      });
    }
  });
}
function closeNewSessionModal(){ var o=document.getElementById('newSessionOverlay'); if(o) o.remove(); }
function createNewSession(){
  var agent=document.getElementById('nsAgent').value;
  var model=document.getElementById('nsModel').value;
  var workspace=document.getElementById('nsWorkspace').value.trim();
  closeNewSessionModal();
  fetch(apiUrl('/api/sessions'), { method:'POST', headers:monitorToken?{'X-Monitor-Token':monitorToken}:{}, body:JSON.stringify({agent:agent,model:model,workspace:workspace}) })
    .then(function(r){return r.json();})
    .then(function(s){
      _sessions.unshift(s);
      currentSession=s.id;
      setSessionAgent(s.id, agent||'default');
      _applyPendingModel(s.id);
      _openTabs.push(s.id); persistTabs();
      var ta=document.getElementById('chatInput'); if(ta) ta.value='';
      renderSessionTabs(); renderRail(); updateHeader();
      var body=document.getElementById('chatBody');
      if(body) body.innerHTML='<div class="system-tip">新会话已创建'+(agent!=='default'?' · Agent: '+esc(agent):'')+(model?' · 模型: '+esc(model):'')+'</div>';
      if(workspace) _fmCwd=workspace;
      toast('✅ 新会话已创建');
    }).catch(function(){ toast('创建会话失败','error'); });
}
function updateHeader(){
  var s = _sessions.find(function(x){ return x.id===currentSession; });
  var title = document.getElementById('chatTitle');
  var sub = document.getElementById('chatSubtitle');
  if(title) title.textContent = s ? (s.title||'未命名会话') : '新对话';
  if(sub) sub.textContent = (s ? (s.title||'会话') : '默认主力助手') + ' · ' + (_sessions.length) + ' 个会话';
  renderSessionTabs();
}
function openRailDrawer(){
  var r=document.getElementById('chatRail'); if(r){ r.classList.remove('hidden'); r.classList.add('open'); }
  var o=document.getElementById('chatRailOverlay'); if(o) o.classList.add('open');
}
function closeRailDrawer(){
  var r=document.getElementById('chatRail'); if(r) r.classList.remove('open');
  var o=document.getElementById('chatRailOverlay'); if(o) o.classList.remove('open');
}
function toggleRail(){
  var rail=document.getElementById('chatRail'); if(!rail) return;
  rail.classList.toggle('hidden');
  var collapsed = rail.classList.contains('hidden');
  var ic=document.getElementById('iconCollapse'), ie=document.getElementById('iconExpand');
  if(ic) ic.style.display = collapsed?'none':'block';
  if(ie) ie.style.display = collapsed?'block':'none';
  var rt=document.getElementById('railToggle'); if(rt) rt.title = collapsed?'展开会话树':'折叠会话树';
  syncSessionTabsVisibility();
}

/* ============================ 对话输入 / 发送 ============================ */
function autoResize(t){
  t.style.height='auto'; t.style.height=t.scrollHeight+'px';
  var btn=document.getElementById('sendBtn'); if(btn) btn.disabled=!t.value.trim() && _pendingAttachments.length===0;
}
function onKey(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendChat(); } }
function sendChat(){
  var ta=document.getElementById('chatInput');
  var text=ta.value.trim();
  if(!text && _pendingAttachments.length===0) return;
  ta.value=''; ta.style.height='auto';
  var btn=document.getElementById('sendBtn'); if(btn) btn.disabled=true;
  if(text.charAt(0)==='/'){ handleSlashCommand(text); return; }
  // 圆桌讨论模式
  if(_rtState.active && currentSession===_rtState.sessionId){ rtSend(text); return; }
  sendRaw(text);
}

/* 真实发送：流式对话（SSE / XHR 降级） */
/* 统一 system 注入点：专家 / 专家团（决策 3）
 * 团队启用 → 优先拼接团队多智能体上下文；否则单专家 → 追加一条 system message（不替换 persona）。
 * 所有专家/专家团注入只走这一处。 */
function injectExpertSystem(sys, userMessage){
  if(!sys) sys='';
  var ext=_cfg.extensions||{};
  // ⓪ 工作流最高优先：启用且有步骤时，注入 DAG 编排上下文，让 AI 按工作流执行
  var wf=ext.workflow;
  if(wf && wf.enabled && wf.steps && wf.steps.length){
    var wl=['', '【工作流 · DAG 编排模式】'];
    wl.push('工作流名称：'+(wf.name||'未命名'));
    if(wf.description) wl.push('描述：'+wf.description);
    wl.push('并发上限：'+(wf.concurrency||2));
    if(wf.inputs && wf.inputs.length){
      wl.push('输入变量：');
      wf.inputs.forEach(function(inp){ wl.push('  - '+inp.name+'：'+(inp.description||'')+(inp.required?'（必填）':'')); });
    }
    // 构建变量替换表：{{request}} → 用户消息，{{context}} → 空
    var varMap = { '{{request}}': (userMessage||''), '{{context}}': '' };
    wl.push('');
    wl.push('执行步骤（按依赖顺序，每个步骤的完整任务指令如下）：');
    wf.steps.forEach(function(s,i){
      var dep=(s.depends_on&&s.depends_on.length)?'（依赖：'+s.depends_on.join(', ')+'）':'';
      wl.push('');
      wl.push('  ── 步骤 '+(i+1)+'：['+s.id+'] ──');
      wl.push('  专家：'+(s.expert||'自动分配')+'  输出变量：'+(s.output||'无')+' '+dep);
      if(s.task){
        // 替换模板变量 {{request}} / {{context}} 为实际值，中间变量（如 {{ceo_decision}}）保留为占位符
        var resolvedTask = s.task;
        Object.keys(varMap).forEach(function(k){
          resolvedTask = resolvedTask.split(k).join(varMap[k]);
        });
        wl.push('  任务指令：');
        resolvedTask.split('\n').forEach(function(line){ wl.push('    '+line); });
      }
    });
    wl.push('');
    wl.push('═══════ 执行规则（必须严格遵守）═══════');
    wl.push('1. 你是工作流编排者，必须使用 delegate_task（任务委派）工具按上述 DAG 依赖顺序逐步执行每个步骤。');
    wl.push('2. 对于没有依赖的步骤（depends_on 为空），可以并行派发 delegate_task。');
    wl.push('3. 对于有依赖的步骤，必须等依赖步骤的 delegate_task 全部返回后，将输出结果填入对应变量（如 {{ceo_decision}}），再派发下一步。');
    wl.push('4. 每次 delegate_task 的 instruction 必须包含对应步骤的完整"任务指令"内容，并将其中仍存在的 {{变量名}} 替换为已获得的实际值。');
    wl.push('5. 所有步骤完成后，汇总各步骤输出，给出完整的最终结果。');
    wl.push('6. 严禁跳过 delegate_task 直接自己作答。必须真实调用 delegate_task 派发子智能体执行每个步骤。');
    return sys + '\n' + wl.join('\n');
  }
  // ① 专家团优先
  if(ext.team_enabled && ext.team && ext.team.length){
    var lines=['', '【专家团 · 多智能体协作模式（必须通过任务委派 delegate_task 执行）】'];
    lines.push('你现在的身份是「主协调智能体」，负责拆解任务、委派专家、汇总结果。你手下有以下专家成员：');
    lines.push('');
    ext.team.forEach(function(m){
      var ap=(window.AGENCY_PERSONAS||[]).find(function(p){ return p.id===m.id; });
      var pm = ap?ap.prompt:'';
      lines.push('◆ 成员：'+(m.name||m.id)+(m.dept?'（'+m.dept+'）':''));
      if(pm) lines.push(pm);
      lines.push('');
    });
    lines.push('═══ 强制执行规则（不可违反）═══');
    lines.push('1. 收到用户任务后，先将其拆解为若干子任务，并判断哪些专家成员与子任务相关。');
    lines.push('2. 对每个相关成员，必须调用 delegate_task（任务委派）工具真实地派发一个子智能体去执行，严禁自己“假装”成专家直接作答。每次 delegate_task 的指令开头必须写明：“你现在扮演【成员名】，其专长如下：<该成员的上述人设>。请完成以下子任务：<具体子任务内容>”。');
    lines.push('3. 调用 delegate_task 时 tasks 参数必须是合法的 JSON 数组（array）：多个任务对象之间必须用英文逗号分隔，中括号 [] 与花括号 {} 必须配对完整，字符串必须用英文双引号包裹，不要遗漏逗号或括号，确保能被 JSON 解析器正确解析（否则会报 “Expecting \',\' delimiter” 错误导致委派失败）。');
    lines.push('4. 与任务无关的成员可以不派发；但至少派发 1 个子任务。能并行就并行派发。');
    lines.push('5. 等所有 delegate_task 子智能体返回结果后，你作为主协调者汇总、去重、整合各方产出，给出结构化的最终答案，并注明各部分来自哪位专家。');
    lines.push('6. 再次强调：不许跳过 delegate_task 直接以单人口吻回答。是否真正调用了 delegate_task 是判断你是否在执行专家团协作的唯一标准。');
    return sys + '\n' + lines.join('\n');
  }
  // ② 单专家（追加，不替换 persona）
  if(_selectedExpert && _selectedExpert.prompt){
    return sys + '\n\n【专家角色】'+(_selectedExpert.name||'')+'\n'+_selectedExpert.prompt;
  }
  return sys;
}

function sendRaw(text){
  var attachments = _pendingAttachments.slice();
  _pendingAttachments = [];
  renderAttachChips();
  var body = document.getElementById('chatBody');
  if(!body) return;

  // 注入引用上下文
  var quoteHtml = '';
  if(_currentQuote){
    quoteHtml = '<div class="quote-block"><div class="quote-label">引用</div>' + escapeHtml(_currentQuote) + '</div>';
    text = '【引用上下文】\n' + _currentQuote + '\n\n【用户追问】\n' + text;
    clearQuote();
  }

  var userDiv = document.createElement('div'); userDiv.className='msg user';
  var chips = attachments.map(function(a){ return '<span class="attach-chip">📎 '+esc(a.name||'附件')+'</span>'; }).join(' ');
  userDiv.innerHTML = '<div class="msg-bubble">'+quoteHtml+escapeHtml(text).replace(/\n/g,'<br>')+(chips?'<div style="margin-top:6px">'+chips+'</div>':'')+'</div><div class="msg-meta">你 · '+fmtDateTime(Date.now())+'</div>';
  body.appendChild(userDiv); body.scrollTop=body.scrollHeight;

  var asst = document.createElement('div'); asst.className='msg assistant';
  asst.innerHTML = '<div class="msg-bubble"><div class="md-text"><span class="cursor-blink">|</span></div><div class="chat-info"></div><div class="tool-calls" data-collapsed="true"><div class="tool-summary" onclick="toggleToolCalls(this.parentNode)"><span class="tc-ico">🛠</span><span class="tc-text">工具调用</span><span class="tc-toggle">展开 ▾</span></div><div class="tool-list"></div></div></div><div class="reply-status thinking" id="replyStatus"><span class="rs-icon">🤔</span><span class="rs-text">正在思考<span class="rs-dots"></span></span><span class="rs-bar"><span class="rs-bar-inner"></span></span></div><div class="msg-meta">Hermes · '+fmtDateTime(Date.now())+'</div>';
  body.appendChild(asst); body.scrollTop=body.scrollHeight;
  var mdEl = asst.querySelector('.md-text');
  var statusEl = asst.querySelector('.reply-status');
  var toolBox = asst.querySelector('.tool-calls');
  var toolList = asst.querySelector('.tool-list');
  var toolSummary = asst.querySelector('.tool-summary');
  var infoEl = asst.querySelector('.chat-info');
  var fullText = '';
  var toolCards = {};
  var toolCount = 0;
  function updateToolSummary(){
    if(!toolSummary) return;
    toolSummary.querySelector('.tc-text').textContent = '已调用 '+toolCount+' 个工具';
    var tog = toolSummary.querySelector('.tc-toggle');
    if(tog) tog.textContent = (toolBox.getAttribute('data-collapsed')==='true') ? '展开 ▾' : '收起 ▴';
  }

  if(!currentSession){
    // 团队模式或工作流启用时，自动创建的会话归入 team 分组
    var _ext = _cfg.extensions || {};
    var _teamOn = _ext.team_enabled && _ext.team && _ext.team.length;
    var _wfOn = _ext.workflow && _ext.workflow.enabled && _ext.workflow.steps && _ext.workflow.steps.length;
    var _aid = (_teamOn || _wfOn) ? 'team' : (currentAgent || 'default');
    if (_teamOn || _wfOn) { ensureAgent('team', { name: _ext.team_name || _ext.workflow.name || '我的团队', icon: _wfOn ? '⚙️' : '👥' }); currentAgent = 'team'; }
    fetch(apiUrl('/api/sessions'), { method:'POST', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ return r.json(); })
      .then(function(s){ _sessions.unshift(s); currentSession=s.id; setSessionAgent(s.id, _aid); _applyPendingModel(s.id); _openTabs.push(s.id); persistTabs(); renderSessionTabs(); renderRail(); updateHeader(); doStream(); })
      .catch(function(){ toast('创建会话失败'); mdEl.textContent='⚠ 无法创建会话'; });
  } else {
    doStream();
  }

  function doStream(){
    var sid = currentSession;  // 捕获：本会话的 sid（后台流式继续时切换不影响这里的 sid）
    _chatHTML[sid] = _chatHTML[sid] || '';  // 初始化缓存（防止首次流式就被清空）
    _tabStreaming[sid] = true; renderSessionTabs();
    var sys = _personaPrompt || '';
    if(_activeSkills.length){ sys += '\n\n【已启用技能】请在本轮对话中优先使用以下技能：'+_activeSkills.join('、')+'。'; }
    sys = injectExpertSystem(sys, text);
    var payload = {
      session_id: sid,
      message: buildMessageContent(text, attachments),
      system: sys
    };
    var _sessModel = _getSessionModel(sid);
    if(_sessModel){
      if(typeof _sessModel === 'object' && _sessModel.model){
        payload.model = _sessModel.model;
        if(_sessModel.provider) payload.provider = _sessModel.provider;
      } else {
        payload.model = _sessModel;
      }
    }
    streamChat(payload, {
      onDelta: function(d){
        fullText += d;
        // 第一次收到内容：切换到“正在回复”状态
        if(statusEl && statusEl.classList.contains('thinking')){
          statusEl.className='reply-status generating';
          statusEl.innerHTML='<span class="rs-icon">✍️</span><span class="rs-text">正在回复<span class="rs-dots"></span></span><span class="rs-bar"><span class="rs-bar-inner"></span></span>';
        }
        mdEl.innerHTML = renderMarkdown(fullText, true); body.scrollTop=body.scrollHeight; _chatHTML[sid] = body.innerHTML;
      },
      onReasoning: function(r){
        // 推理模型思考过程：状态从“正在思考”切换，并流式显示思考块（避免 content 为空时 UI 卡死）
        if(statusEl && statusEl.classList.contains('thinking')){
          statusEl.className='reply-status generating';
          statusEl.innerHTML='<span class="rs-icon">💭</span><span class="rs-text">正在思考<span class="rs-dots"></span></span><span class="rs-bar"><span class="rs-bar-inner"></span></span>';
        }
        var rb = asst.querySelector('.reasoning-block');
        if(!rb){
          rb = document.createElement('div');
          rb.className = 'reasoning-block';
          rb.innerHTML = '<div class="reasoning-head">💭 思考过程</div><div class="reasoning-text"></div>';
          mdEl.parentNode.insertBefore(rb, mdEl);
        }
        rb.querySelector('.reasoning-text').textContent += r;
        rb.scrollTop = rb.scrollHeight;
        body.scrollTop=body.scrollHeight; _chatHTML[sid] = body.innerHTML;
      },
      onTool: function(tp){
        // 技能调用渲染为 chip（Issue #9），不占完整工具卡片
        if(tp.skill || (tp.tool && /skill/i.test(tp.tool))){
          var sName = tp.toolZh || tp.name || tp.tool || '技能';
          var chip = document.createElement('span');
          chip.className = 'skill-invoke-chip';
          chip.textContent = '🧩 ' + sName;
          toolList.appendChild(chip);
          updateToolSummary();
          body.scrollTop=body.scrollHeight;
          _chatHTML[sid] = body.innerHTML;
          return;
        }
        var id = tp.toolCallId || tp.tool || 'tool';
        var card = toolCards[id];
        if(!card){
          card = document.createElement('div');
          card.className = 'tool-call';
          if(tp.toolCallId) card.setAttribute('data-tid', tp.toolCallId);
          toolList.appendChild(card);
          toolCards[id] = card;
          toolCount++;
        }
        // 同一工具可能多次推送事件（start → done → result），按最新状态重绘
        var running = !(tp.status==='done'||tp.status==='completed'||tp.status==='finish'||tp.status==='finished');
        var hasResult = !!(tp.result);
        // 含结果且已完成时默认折叠，避免长输出淹没聊天
        var collapsed = (!running && hasResult);
        card.className = 'tool-call' + (running ? ' running' : '') + (collapsed ? ' collapsed' : '');
        var emoji = tp.emoji || TOOL_EMOJI[tp.tool] || '🔧';
        var name = tp.toolZh || TOOL_NAME_ZH[tp.tool] || tp.tool || '工具';
        var html = '<div class="tool-head" onclick="this.parentNode.classList.toggle(\'collapsed\')">'+
          '<span class="tool-icon">'+emoji+'</span>'+
          '<span class="tool-name">'+esc(name)+'</span>'+
          '<span class="tool-status '+(running?'running':'done')+'">'+(running?'执行中…':'已完成')+'</span>'+
        '</div>';
        var label = tp.label || tp.command || tp.summary || '';
        if(label) html += '<div class="tool-cmd"><span class="tool-cmd-label">命令</span>'+escapeHtml(label)+'</div>';
        if(tp.result) html += '<div class="tool-out"><span class="tool-cmd-label">结果</span>'+escapeHtml(tp.result)+'</div>';
        card.innerHTML = html;
        updateToolSummary();
        // 流式进行中（有运行中的工具）保持展开；全部完成后折叠
        if(running) toolBox.setAttribute('data-collapsed','false');
        body.scrollTop=body.scrollHeight;
        _chatHTML[sid] = body.innerHTML;
      },
      onInfo: function(i){
        if(!i) return;
        infoEl.innerHTML = '<span class="info-dot"></span>'+escapeHtml(i);
        infoEl.style.display = 'flex';
        body.scrollTop=body.scrollHeight;
        _chatHTML[sid] = body.innerHTML;
      },
      onUsage: function(u){
        if(!u) return;
        var meta = asst.querySelector('.msg-meta');
        if(meta){
          var t = (u.total_tokens!=null) ? u.total_tokens
                : ((u.prompt_tokens||0) + (u.completion_tokens||0));
          meta.textContent = 'Hermes · '+fmtDateTime(Date.now())+' · ' + t + ' tokens';
        }
      },
      onError: function(err){ var _raw = String(err||''); var _needCfg = /No inference provider configured/i.test(_raw); var _html = _needCfg ? '⚠ 尚未配置模型服务：请先到「模型」页添加模型供应商并填写 API Key。<br><span style="font-size:11px;opacity:.8">（网关返回：'+esc(_raw)+'）</span>' : '⚠ '+esc(_raw); mdEl.innerHTML = '<span class="error-text">'+_html+'</span>' + (_needCfg ? '<div style="margin-top:8px"><button onclick="switchPage(\'models\')" style="padding:5px 12px;border-radius:8px;border:1px solid var(--red);background:transparent;color:var(--red);cursor:pointer;font-size:12px">去配置模型 →</button></div>' : ''); if(_needCfg) renderConfigBanner(); if(statusEl){ statusEl.className='reply-status done'; statusEl.innerHTML='<span class="rs-icon">⚠️</span><span class="rs-text">回复出错</span>'; statusEl.style.color='var(--red)'; } _tabStreaming[sid]=false; renderSessionTabs(); _chatHTML[sid] = body.innerHTML; },
      onDone: function(aborted){
        _tabStreaming[sid]=false; renderSessionTabs();
        mdEl.innerHTML = renderMarkdown(fullText) + (aborted ? ' <em>(已停止)</em>' : '');
        infoEl.style.display = 'none';
        // 状态指示器：显示“回答完成”
        if(statusEl){
          statusEl.className='reply-status done';
          statusEl.innerHTML='<span class="rs-icon">✅</span><span class="rs-text">'+(aborted?'已停止':'回答完成')+'</span><span class="rs-bar"><span class="rs-bar-inner" style="width:100%"></span></span>';
          setTimeout(function(){ statusEl.classList.add('fade-out'); }, 4000);
          setTimeout(function(){ statusEl.style.display='none'; }, 4600);
        }
        // 完成后折叠工具区（Issue #8）；若仍有运行中的工具则保持展开
        if(toolBox){
          var anyRunning = toolList.querySelector('.tool-call.running');
          if(!anyRunning){ toolBox.setAttribute('data-collapsed','true'); updateToolSummary(); }
          else { toolBox.setAttribute('data-collapsed','false'); updateToolSummary(); }
        }
        hideScrollBtn();
        _msgState.streaming=false; _msgState.abortCtrl=null;
        // 添加操作按钮（播放/引用/Fork）
        asst.setAttribute('data-content', fullText.replace(/\n/g,'&#10;').replace(/"/g,'&quot;'));
        var actBar=document.createElement('div'); actBar.className='msg-actions';
        actBar.innerHTML='<button class="msg-act-btn" onclick="speakMsg(this)" title="语音播放"><svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>播放</button>' +
          '<button class="msg-act-btn" onclick="quoteMsg(this)" title="引用回复"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>引用</button>' +
          '<button class="msg-act-btn" onclick="forkMsg(this)" title="Fork 新话题"><svg viewBox="0 0 24 24"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><path d="M12 12v3"/></svg>Fork</button>';
        asst.insertBefore(actBar, asst.querySelector('.msg-meta'));
        _chatHTML[sid] = body.innerHTML;  // 完成后同步缓存
        loadSessions();
      }
    });
  }
}
function buildMessageContent(text, attachments){
  var imgs=[], files=[];
  (attachments||[]).forEach(function(a){ if(a.type && a.type.indexOf('image/')===0) imgs.push(a.url); else files.push(a.url); });
  return { text: text||'', images: imgs, files: files };
}

/* 流式聊天：WebSocket 主通道（抗代理超时 + 自动重连），SSE/XHR 降级 */
function wsChatUrl(sid){
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + apiUrl('/api/chat/ws') + '?session_id=' + encodeURIComponent(sid) + '&token=' + encodeURIComponent(monitorToken || '');
}
function streamChat(payload, cb){
  _msgState.streaming = true;
  var done = false;
  var ws = null;
  var fallbackTimer = null;
  var wsOpened = false;
  var reconnectAttempts = 0;
  var maxReconnects = 3;  // 最多自动重连 3 次
  var reconnectDelay = 2000; // 首次重连延迟 2s

  function finish(){
    if(done) return; done = true;
    clearTimeout(fallbackTimer);
    _msgState.streaming = false; _msgState.abortCtrl = null; _msgState.ws = null;
  }
  function handleMsg(p){
    if(p.keepalive) return;
    if(p.delta) cb.onDelta(p.delta);
    else if(p.reasoning && cb.onReasoning) cb.onReasoning(p.reasoning);
    else if(p.tool_progress) cb.onTool(p.tool_progress);
    else if(p.error) cb.onError(p.error);
    else if(p.info) cb.onInfo(p.info);
    else if(p.usage && cb.onUsage) cb.onUsage(p.usage);
  }
  function doFallback(){
    if(done) return;
    console.warn('[Chat] WS fallback to SSE after ' + reconnectAttempts + ' reconnect attempts');
    streamChatSSE(payload, cb);
    finish();
  }

  function tryReconnect(){
    if(done || reconnectAttempts >= maxReconnects){ doFallback(); return; }
    reconnectAttempts++;
    var delay = reconnectDelay * Math.pow(2, reconnectAttempts - 1); // 2s, 4s, 8s
    console.log('[Chat] WS reconnect attempt ' + reconnectAttempts + '/' + maxReconnects + ' in ' + delay + 'ms');
    cb.onInfo && cb.onInfo('连接中断，正在重连(' + reconnectAttempts + '/' + maxReconnects + ')…');
    setTimeout(function(){
      if(done) return;
      try { ws = new WebSocket(wsChatUrl(payload.session_id)); } catch(e){ doFallback(); return; }
      _msgState.ws = ws;
      var reconnectTimer = setTimeout(function(){
        if(ws && ws.readyState !== WebSocket.OPEN){ try{ ws.close(); }catch(e){} tryReconnect(); }
      }, 10000);
      ws.onopen = function(){
        clearTimeout(reconnectTimer);
        console.log('[Chat] WS reconnected successfully');
        cb.onInfo && cb.onInfo('重连成功，继续接收回复…');
        // 重连后服务器会从缓存返回完整结果
      };
      ws.onmessage = function(e){
        try {
          var p = JSON.parse(e.data);
          if(p.done){ finish(); cb.onDone(false); try{ ws.close(); }catch(ex){} return; }
          handleMsg(p);
        } catch(ex){}
      };
      ws.onerror = function(){
        if(done) return;
        clearTimeout(reconnectTimer);
        tryReconnect();
      };
      ws.onclose = function(ev){
        if(done) return;
        clearTimeout(reconnectTimer);
        if(ev.code !== 1000){ tryReconnect(); }
        else { finish(); cb.onDone(false); }
      };
    }, delay);
  }

  // 1) POST 消息入队
  fetch(apiUrl('/api/chat/ws-send'), {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Monitor-Token': monitorToken||'' },
    body: JSON.stringify(payload)
  }).then(function(r){
    if(!r.ok) throw new Error('ws-send ' + r.status);
    return r.json();
  }).then(function(){
    if(done) return;
    // 2) 建立 WS 连接取流
    try { ws = new WebSocket(wsChatUrl(payload.session_id)); } catch(e){ doFallback(); return; }
    _msgState.ws = ws;
    _msgState.abortCtrl = { abort: function(){ try{ ws.close(1000, 'user stop'); }catch(e){} } };

    // 30 秒内未 open 则降级（从 15s 延长到 30s，给慢网络更多时间）
    fallbackTimer = setTimeout(function(){
      if(ws && ws.readyState !== WebSocket.OPEN){ try{ ws.close(); }catch(e){} doFallback(); }
    }, 30000);

    ws.onopen = function(){ wsOpened = true; clearTimeout(fallbackTimer); };
    ws.onmessage = function(e){
      try {
        var p = JSON.parse(e.data);
        if(p.done){ finish(); cb.onDone(false); try{ ws.close(); }catch(ex){} return; }
        handleMsg(p);
      } catch(ex){}
    };
    ws.onerror = function(){
      if(done) return;
      clearTimeout(fallbackTimer);
      // 如果 WS 曾连接成功后断开，尝试重连而非直接降级
      if(wsOpened){ tryReconnect(); }
      else { doFallback(); }
    };
    ws.onclose = function(ev){
      if(done) return;
      clearTimeout(fallbackTimer);
      if(ev.code !== 1000){
        console.warn('[Chat] WS closed abnormally code=' + ev.code);
        // 如果 WS 曾连接成功后断开，尝试重连
        if(wsOpened){ tryReconnect(); }
        else { doFallback(); }
      } else {
        finish(); cb.onDone(false);
      }
    };
  }).catch(function(){
    // ws-send 失败 → 直接走 SSE
    doFallback();
  });
}

/* SSE 降级路径（fetch 优先，再降 XHR） */
function streamChatSSE(payload, cb){
  _msgState.streaming = true;
  var controller = new AbortController();
  _msgState.abortCtrl = { abort: function(){ try{ controller.abort(); }catch(e){} } };

  function handleEvent(p){
    if(p.tool_progress) cb.onTool(p.tool_progress);
    else if(p.delta) cb.onDelta(p.delta);
    else if(p.reasoning && cb.onReasoning) cb.onReasoning(p.reasoning);
    else if(p.error) cb.onError(p.error);
    else if(p.info) cb.onInfo(p.info);
    else if(p.usage) cb.onUsage && cb.onUsage(p.usage);
  }

  fetch(apiUrl('/api/chat/stream'), {
    method:'POST',
    headers: { 'Content-Type':'application/json', 'X-Monitor-Token': monitorToken||'' },
    body: JSON.stringify(payload),
    signal: controller.signal
  }).then(function(r){
    if(!r.ok){ cb.onError('HTTP '+r.status); cb.onDone(false); return; }
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    function pump(){
      reader.read().then(function(res){
        if(res.done){ cb.onDone(false); return; }
        buf += dec.decode(res.value, { stream:true });
        var events = buf.split('\n\n'); buf = events.pop() || '';
        events.forEach(function(ev){
          ev.split('\n').forEach(function(line){
            if(line.indexOf('data:')===0){
              var data = line.slice(5).trim();
              if(data==='[DONE]') return;
              try { handleEvent(JSON.parse(data)); } catch(e){}
            }
          });
        });
        pump();
      }).catch(function(){ cb.onDone(false); });
    }
    pump();
  }).catch(function(e){
    if(e && e.name==='AbortError'){ cb.onDone(true); return; }
    streamChatXhr(payload, cb);
  });
}
function streamChatXhr(payload, cb){
  var xhr = new XMLHttpRequest();
  _msgState.abortCtrl = { abort: function(){ try{ xhr.abort(); }catch(e){} } };
  var buf='', pos=0, done=false;
  function process(){
    var chunk = buf.slice(pos); pos = buf.length; buf += '';
    var rest = chunk; var events = rest.split('\n\n'); buf = events.pop() || '';
    events.forEach(function(ev){
      ev.split('\n').forEach(function(line){
        if(line.indexOf('data:')===0){
          var data = line.slice(5).trim();
          if(data==='[DONE]') return;
          try { var p=JSON.parse(data); handleXhr(p); } catch(e){}
        }
      });
    });
    function handleXhr(p){
      if(p.tool_progress) cb.onTool(p.tool_progress);
      else if(p.delta) cb.onDelta(p.delta);
      else if(p.reasoning && cb.onReasoning) cb.onReasoning(p.reasoning);
      else if(p.error) cb.onError(p.error);
      else if(p.info) cb.onInfo(p.info);
    }
  }
  xhr.open('POST', apiUrl('/api/chat/stream'), true);
  xhr.setRequestHeader('Content-Type','application/json');
  if(monitorToken) xhr.setRequestHeader('X-Monitor-Token', monitorToken);
  xhr.onprogress = function(){ var t=xhr.responseText; var evs=t.slice(pos).split('\n\n'); buf = t; process(); };
  xhr.onload = function(){ if(done) return; done=true; process(); if(xhr.status>=400) cb.onError('HTTP '+xhr.status); cb.onDone(false); };
  xhr.onerror = function(){ if(done) return; done=true; cb.onError('网络错误'); cb.onDone(false); };
  xhr.onabort = function(){ if(done) return; done=true; cb.onDone(true); };
  xhr.send(JSON.stringify(payload));
}
function chatStop(){
  if(currentSession){
    fetch(apiUrl('/api/chat/stop'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ session_id: currentSession }) }).catch(function(){});
  }
  if(_msgState.ws){ try{ _msgState.ws.close(1000, 'user stop'); }catch(e){} _msgState.ws=null; }
  if(_msgState.abortCtrl) _msgState.abortCtrl.abort();
}

/* 附件上传（Profile 隔离：profile=当前 Agent，存 profiles/<agent>/uploads/） */
function uploadAttachment(f, url){
  var fd = new FormData();
  fd.append('file', f);
  fd.append('profile', window.currentAgent || 'default');
  var hdrs = {}; if(monitorToken) hdrs['X-Monitor-Token']=monitorToken;
  return fetch(apiUrl(url), { method:'POST', body:fd, headers:hdrs })
    .then(function(r){ return r.json(); })
    .then(function(out){
      if(out && !out.error && out.url){
        _pendingAttachments.push({ url:out.url, type:f.type, name:(f.name || 'file') });
        renderAttachChips();
        autoResize(document.getElementById('chatInput'));
        return true;
      }
      toast('上传失败：'+(out && out.error || '未知错误'));
      return false;
    })
    .catch(function(){ toast('上传失败，无法连接后端'); return false; });
}
function attachFile(){
  var inp = document.createElement('input'); inp.type='file'; inp.style.display='none';
  document.body.appendChild(inp);
  inp.onchange = function(){
    var f = inp.files[0];
    if(!f){ document.body.removeChild(inp); return; }
    var isImg = /^image\//.test(f.type);
    uploadAttachment(f, isImg ? '/api/chat/upload-image' : '/api/chat/upload-file').then(function(ok){
      if(ok) toast('附件已添加：'+f.name);
    });
    document.body.removeChild(inp);
  };
  inp.click();
}
function renderAttachChips(){
  var comp = document.getElementById('chatComposer');
  if(!comp) return;
  var box = document.getElementById('attachChips');
  if(!box){ box=document.createElement('div'); box.id='attachChips'; box.className='attach-chips'; comp.insertBefore(box, comp.firstChild); }
  if(!_pendingAttachments.length){ box.style.display='none'; box.innerHTML=''; return; }
  box.style.display='flex';
  box.innerHTML = _pendingAttachments.map(function(a,i){
    var isImg = a.type && /^image\//.test(a.type);
    var icon = isImg ? '🖼️' : '📎';
    var name = esc(a.name || (isImg ? '图片' : '附件'));
    return '<span class="attach-chip"><span class="file-icon">'+icon+'</span><span class="file-name" title="'+name+'">'+name+'</span><span class="x" onclick="removeAttach('+i+')" title="移除">×</span></span>';
  }).join('');
}
function removeAttach(i){
  _pendingAttachments.splice(i,1);
  renderAttachChips();
  autoResize(document.getElementById('chatInput'));
}

/* 聊天输入框粘贴图片/文件（Ctrl+V）
 * - 图片 → upload-image（Profile 隔离）
 * - 其他文件（如剪贴板文件复制）→ upload-file
 * - 纯文本不拦截，保持原样 */
function onChatPaste(e){
  var cd = (e && e.clipboardData) || window.clipboardData || null;
  if(!cd || !cd.items) return;            // 无剪贴板数据：交给浏览器默认行为
  // 先同步收集所有文件，避免 items 在异步回调中失效
  var files = [];
  for(var i=0;i<cd.items.length;i++){
    var it = cd.items[i];
    if(it.kind === 'file'){
      var f = it.getAsFile();
      if(f) files.push(f);
    }
  }
  if(!files.length) return;              // 纯文本：不拦截，允许默认粘贴
  e.preventDefault();                     // 检测到文件：阻止文本域写入原始数据
  files.forEach(function(f){
    var isImg = /^image\//.test(f.type || '');
    uploadAttachment(f, isImg ? '/api/chat/upload-image' : '/api/chat/upload-file');
  });
}

/* ============================ Mini Popup ============================ */
/* 构建模型下拉选项（按 Provider 分组、仅含启用模型）；当前值不在列表中时补一个自定义项 */
function buildModelOptionsHtml(currentValue, emptyLabel){
  var cur = String(currentValue||'');
  var html = '<option value="">'+esc(emptyLabel||'（跟随默认配置）')+'</option>';
  var found = !cur;
  (_cfg.providers||[]).forEach(function(p){
    var provName = p.name || p.id;
    var models = (p.models && p.models.length) ? p.models : [{ id:p.model||'auto', name:p.model||'auto', enabled:true }];
    var opts='';
    models.forEach(function(m){
      if(m.enabled === false) return;
      var modelId = m.id || m.name || 'auto';
      var modelName = m.name || m.id || 'auto';
      if(modelId===cur) found=true;
      opts += '<option value="'+esc(modelId)+'"'+(modelId===cur?' selected':'')+'>'+esc(modelName)+'</option>';
    });
    if(opts) html += '<optgroup label="'+esc(provName)+'">'+opts+'</optgroup>';
  });
  if(!found) html += '<optgroup label="当前配置"><option value="'+esc(cur)+'" selected>'+esc(cur)+'（不在模型列表中）</option></optgroup>';
  return html;
}
function buildMiniData(){
  // 模型选择器：按 Provider 分组展示模型列表（Issue #5），避免全部挤在一起
  var modelGroups = [];
  (_cfg.providers||[]).forEach(function(p){
    var provName = p.name || p.id;
    var provId = p.id || p.name;
    var models = (p.models && p.models.length) ? p.models : [{ id:p.model||'auto', name:p.model||'auto', enabled:true }];
    var enabledModels = [];
    models.forEach(function(m){
      if(m.enabled === false) return;
      var modelId = m.id || m.name || 'auto';
      var modelName = m.name || m.id || 'auto';
      var isActive = false;
      var _curModel = _getSessionModel();
      if(_curModel && typeof _curModel === 'object' && _curModel.model){
        isActive = (_curModel.provider === provId && _curModel.model === modelId);
      }
      enabledModels.push({ t: modelName, d: modelId, ico:'⚙️', active: isActive, provider: provId, model: modelId });
    });
    if(enabledModels.length) modelGroups.push({ name: provName, base_url: p.base_url||'', items: enabledModels });
  });
  if(!modelGroups.length) modelGroups = [{ name:'未配置', items:[{ t:'未配置模型', d:'请到「模型」页添加', ico:'⚙️' }] }];
  var connectors = (_connState.list||[]).map(function(c){
    return { t:c.name||c.kind, d:c.configured?'已启用':'未配置', ico:(c.icon||'🔌') };
  });
  if(!connectors.length) connectors = PV.octopConnectors.slice(0,3).map(function(c){ return { t:c.name, d:'未配置', ico:c.icon }; });
  var skills = (_skillLocal.length?_skillLocal:(_state&&_state.skills&&PV.skillsLocal))||[];
  var skillItems = (skills.length?skills:PV.skillsLocal).map(function(sk){
    var nm = sk.name||sk.id||'技能';
    return { t:nm, d:sk.desc||sk.description||'', ico:sk.icon||'📦', active:_activeSkills.indexOf(nm)>=0 };
  });
  return {
    model:{ title:'选择模型', groups:modelGroups },
    connector:{ title:'选择连接器', items:connectors, foot:'管理连接器' },
    skill:{ title:'选择技能', items:skillItems },
    expert:{ title:'选择专家', items: expertsList().map(function(e){ return { id:e.id, t:e.name, d:e.dept||'', ico:e.icon||'🎯', active:false }; }) },
    quick:{ title:'快捷指令', search:false, groups:PV.quickGroups }
  };
}
function expertsList(){
  if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){
    return window.AGENCY_PERSONAS.map(function(p){
      return { id:p.id, name:(p.label||p.name||'未命名'), dept:(p.dept_label||p.dept||''), deptId:(p.dept||''), icon:(p.emoji||p.icon||'🎯') };
    });
  }
  return PV.experts.map(function(e){ return { id:e.id, name:e.name, dept:(e.dept||''), deptId:(e.dept||''), icon:(e.icon||'🎯') }; });
}
/* 动态加载 agency-agents-zh 专家库（Issue #1）。
   打包后的 app 中 js/personas_library.js 可能因浏览器缓存/加载时序失败，这里兜底注入并回调重渲染。
   采用版本号缓存键（替代 Date.now() 强制每次重下载）+ 多次重试，确保 268 位专家必然加载。 */
function ensurePersonasLibrary(cb, attempt){
  if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){ if(cb) cb(); return; }
  attempt = attempt || 1;
  var s = document.createElement('script');
  s.src = 'js/personas_library.js?v=' + (window.__APP_VER__ || 'app') + '&t=' + attempt;
  s.onload = function(){ if(cb) cb(); };
  s.onerror = function(){
    if(attempt < 4){ setTimeout(function(){ ensurePersonasLibrary(cb, attempt + 1); }, 400 * attempt); }
    else if(cb) cb();
  };
  document.head.appendChild(s);
}
/* 启动时强制刷新专家库（即便 index.html 已同步加载，也重新拉取最新版，规避旧缓存导致只剩 8 个） */
function bootstrapPersonasLibrary(){
  ensurePersonasLibrary(function(){
    if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){
      if(window.__expRendered){ renderExperts(); }
      if(window.__personasOpenMini){ window.__personasOpenMini(); }
    }
  });
}
function openMini(btn, key){
  if(activeBtn===btn){ closeMini(); return; }
  closeMini();
  activeBtn=btn; activePanel=key;
  popup=document.getElementById('miniPopup');
  var d=buildMiniData()[key];
  document.getElementById('popupTitle').textContent=d.title;
  var sw=document.getElementById('popupSearchWrap');
  sw.style.display = d.search===false ? 'none':'block';
  if(d.search!==false){ var _ps=document.getElementById('popupSearch'); _ps.placeholder='搜索'+d.title.replace('选择',''); _ps.value=''; }
  var foot=document.getElementById('popupFoot');
  if(d.foot){ foot.style.display='block'; foot.textContent=d.foot; foot.onclick=function(){ closeMini(); switchPage('connectors'); }; }
  else foot.style.display='none';

  var tabs=document.getElementById('popupTabs');
  if(key==='expert'){
    tabs.style.display='flex';
    tabs.innerHTML='<div class="mini-popup-tab '+(_expertPickerTab==='single'?'active':'')+'" onclick="switchExpertPickerTab(\'single\')">专家</div>'+
      '<div class="mini-popup-tab '+(_expertPickerTab==='team'?'active':'')+'" onclick="switchExpertPickerTab(\'team\')">专家团</div>'+
      '<div class="mini-popup-tab '+(_expertPickerTab==='workflow'?'active':'')+'" onclick="switchExpertPickerTab(\'workflow\')">工作流</div>'+
      '<div class="mini-popup-tab '+(_expertPickerTab==='persona'?'active':'')+'" onclick="switchExpertPickerTab(\'persona\')">智能体</div>';
  } else {
    tabs.style.display='none'; tabs.innerHTML='';
  }

  document.getElementById('popupBody').innerHTML=buildMiniPopupBody(key,d);
  popup.classList.toggle('wide', key==='quick');
  popup.classList.add('open');
  positionPopup(btn);
}
function switchExpertPickerTab(tab){
  _expertPickerTab=tab;
  var tabNames={single:'专家',team:'专家团',workflow:'工作流',persona:'智能体'};
  var tabs=document.getElementById('popupTabs');
  Array.from(tabs.children).forEach(function(el){ el.classList.toggle('active', el.textContent===tabNames[tab]); });
  document.getElementById('popupBody').innerHTML=buildMiniPopupBody('expert', buildMiniData().expert);
}
function buildMiniPopupBody(key,d){
  var body='';
  if(key==='quick'){
    body='<div class="cmd-grid">';
    (d.groups||[]).forEach(function(g){
      body+='<div class="cmd-group-title">'+esc(g.title)+'</div>';
      g.commands.forEach(function(c){
        body+='<div class="cmd-cell" onclick="pickQuick(\''+esc(c.cmd).replace(/\\/g,'\\\\').replace(/'/g,"\\'")+'\')">'+
          '<div class="ico">'+c.ico+'</div><div><div class="title">'+esc(c.title)+'</div><div class="sub">'+esc(c.cmd)+'</div></div></div>';
      });
    });
    body+='</div>';
  } else if(key==='model'){
    // 模型选择器：按 Provider 分组渲染，支持会话级模型选择
    body='<div class="pick-list pick-groups">';
    // 添加"跟随默认"选项（清除当前会话的模型选择）
    var _curModel = _getSessionModel();
    body+='<div class="pop-item '+(!_curModel?'active':'')+'" data-clear="1" onclick="clearSessionModel()" style="border-bottom:1px solid var(--border);margin-bottom:4px;padding-bottom:8px">'+
      '<div class="ico">🔄</div><div class="txt"><div class="t">跟随默认配置</div><div class="d">清除当前会话的模型选择</div></div><div class="check"></div></div>';
    (d.groups||[]).forEach(function(g){
      body+='<div class="pick-group"><div class="pick-group-head">'+esc(g.name)+'</div>';
      (g.items||[]).forEach(function(it){
        var _attrs = ' data-provider="'+esc(it.provider||g.name)+'" data-model="'+esc(it.model||it.t)+'"';
        body+='<div class="pop-item '+(it.active?'active':'')+'"'+_attrs+' onclick="pickItem(\'model\',this)">'+
        '<div class="ico">'+it.ico+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div><div class="d">'+esc(it.d)+'</div></div><div class="check"></div></div>';
      });
      body+='</div>';
    });
    body+='</div>';
    // 添加提示：模型选择是会话级的
    body+='<div style="padding:8px 12px;font-size:11px;color:var(--text3);border-top:1px solid var(--border)">💡 模型选择仅对当前会话生效，切换会话后可选择不同模型</div>';
  } else if(key==='expert'){
    if(_expertPickerTab==='team'){
      var team=_cfg.extensions.team||[];
      if(!team.length){
        body='<div class="pick-list"><div class="empty-state" style="padding:20px 0;text-align:center;color:var(--text3)">专家团为空。<br>点击下方「使用专家团」将自动按部门组建跨领域团队。</div></div>';
      } else {
        body='<div class="pick-list">';
        team.forEach(function(m){
          body+='<div class="pop-item" data-id="'+esc(m.id||'')+'">'+
            '<div class="ico">'+(m.icon||'🎯')+'</div><div class="txt"><div class="t">'+esc(m.name||'')+'</div><div class="d">'+esc(m.dept||'')+'</div></div>'+
            '<button class="action sm" onclick="event.stopPropagation();removeTeamMember(\''+esc(m.id)+'\')" style="margin-top:0;flex:none">移除</button>'+
            '</div>';
        });
        body+='</div><div class="team-cta-wrap"><button class="team-cta '+(_cfg.extensions.team_enabled?'on':'off')+'" onclick="useExpertTeam()">'+
          '<span class="ico">'+( _cfg.extensions.team_enabled?'✓':'👥' )+'</span>'+
          '<span>'+(_cfg.extensions.team_enabled?'已启用专家团':'使用专家团')+'</span>'+
          '<span class="hint">'+( _cfg.extensions.team_enabled?'点击重新应用':'多智能体协作' )+'</span>'+
          '</button></div>';
      }
    } else if(_expertPickerTab==='workflow'){
      var presets=window.AO_WORKFLOW_PRESETS||[];
      var curKey=String((_cfg.extensions.workflow&&_cfg.extensions.workflow.key)||'').replace(/\\/g,'/');
      var curEnabled=!!(_cfg.extensions.workflow&&_cfg.extensions.workflow.enabled&&_cfg.extensions.workflow.steps&&_cfg.extensions.workflow.steps.length);
      if(!presets.length){
        body='<div class="pick-list"><div class="empty-state" style="padding:20px 0;text-align:center;color:var(--text3)">暂无工作流模板。<br>请在「扩展→工作流」页面添加。</div></div>';
      } else {
        body='<div class="pick-list">';
        presets.forEach(function(p){
          var isActive=(curEnabled&&String(p.key).replace(/\\/g,'/')===curKey);
          body+='<div class="pop-item'+(isActive?' active':'')+'" data-key="'+esc(p.key)+'" onclick="pickWorkflowFromMini(this.getAttribute(\'data-key\'))">' +
            '<div class="ico">🎛️</div><div class="txt"><div class="t">'+esc(p.name)+'</div><div class="d">'+esc(p.description||'')+(isActive?' · 当前已启用':'')+'</div></div><div class="check"></div></div>';
        });
        body+='</div>';
        if(curEnabled){
          body+='<div class="team-cta-wrap"><button class="team-cta on" onclick="clearWorkflowFromMini()">'+
            '<span class="ico">✓</span><span>已启用工作流：'+esc((_cfg.extensions.workflow||{}).name||'')+'</span><span class="hint">点击停用</span></button></div>';
        }
      }
    } else if(_expertPickerTab==='persona'){
      var personas=allPersonas();
      body='<div class="pick-list">';
      Object.keys(personas).forEach(function(k){
        var p=personas[k];
        var isActive=(_persona===k);
        body+='<div class="pop-item'+(isActive?' active':'')+'" data-id="'+esc(k)+'" onclick="pickPersonaFromMini(\''+esc(k).replace(/'/g,"\\'")+'\')">' +
          '<div class="ico">'+(p.emoji||'🤖')+'</div><div class="txt"><div class="t">'+esc(p.label||k)+'</div><div class="d">'+esc((p.prompt||'').slice(0,40))+(isActive?' · 当前角色':'')+'</div></div><div class="check"></div></div>';
      });
      body+='</div>';
    } else {
      body='<div class="pick-list">';
      (d.items||[]).forEach(function(it){
        // 选中态：与「单专家注入对象」_selectedExpert 比对
        var selExpert = (_selectedExpert && _selectedExpert.id===(it.id||''));
        body+='<div class="pop-item'+(selExpert?' active':'')+'" data-id="'+esc(it.id||'')+'" onclick="pickItem(\'expert\',this)">'+
          '<div class="ico">'+it.ico+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div><div class="d">'+esc(it.d)+'</div></div><div class="check"></div></div>';
      });
      body+='</div>';
    }
  } else {
    body='<div class="pick-list">';
    (d.items||[]).forEach(function(it){
      body+='<div class="pop-item '+(it.active?'active':'')+'" onclick="pickItem(\''+key+'\',this)">'+
        '<div class="ico">'+it.ico+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div><div class="d">'+esc(it.d)+'</div></div><div class="check"></div></div>';
    });
    body+='</div>';
  }
  return body;
}
/* 迷你弹窗通用搜索过滤：模型/专家/技能/连接器/快捷指令条目按文本实时筛选。
   模型多达上百个时避免逐个翻找；过滤后空分组连同组头一起隐藏。 */
function filterMiniPopup(){
  var ps=document.getElementById('popupSearch'); if(!ps) return;
  var q=(ps.value||'').trim().toLowerCase();
  var body=document.getElementById('popupBody'); if(!body) return;
  body.querySelectorAll('.pop-item').forEach(function(it){
    var txt=((it.textContent||'')+' '+(it.getAttribute('data-provider')||'')+' '+(it.getAttribute('data-model')||'')).toLowerCase();
    it.style.display = (!q || txt.indexOf(q)>=0) ? '' : 'none';
  });
  body.querySelectorAll('.pick-group').forEach(function(g){
    var any=false; g.querySelectorAll('.pop-item').forEach(function(it){ if(it.style.display!=='none') any=true; });
    g.style.display = (!q || any) ? '' : 'none';
  });
  body.querySelectorAll('.cmd-cell').forEach(function(c){
    var txt=(c.textContent||'').toLowerCase();
    c.style.display = (!q || txt.indexOf(q)>=0) ? '' : 'none';
  });
}
function positionPopup(btn){
  if(window.innerWidth<=768) return;
  popup.classList.add('top');
  var rect=btn.getBoundingClientRect();
  var width=activePanel==='quick'?560:360;
  var left=rect.left + rect.width/2 - width/2;
  if(left<8) left=8;
  if(left+width>window.innerWidth-8) left=window.innerWidth-width-8;
  popup.style.left=left+'px';
  popup.style.top=(rect.top - popup.offsetHeight - 10)+'px';
  popup.style.width=width+'px';
  var arrowLeft=rect.left + rect.width/2 - left;
  popup.style.setProperty('--arrow-left', Math.max(18, Math.min(width-18, arrowLeft))+'px');
}
function closeMini(){
  if(popup){ popup.classList.remove('open','wide'); }
  activeBtn=null; activePanel=null;
  document.querySelectorAll('.tool-btn').forEach(function(b){ b.classList.remove('active'); });
}
function pickItem(key, el){
  var name = el.querySelector('.t') ? el.querySelector('.t').textContent : '';
  if(key==='expert'){
    // 工具栏专家选择器：为专家开启独立会话并注入单专家（决策 3，不替换 persona）
    pickItemExpert(el.getAttribute('data-id'), el);
    return;
  } else if(key==='model'){
    var b=document.getElementById('btnModel');
    if(b){
      b.setAttribute('data-tip','模型: '+name); b.classList.add('active');
      // 更新徽章
      var oldBadge = b.querySelector('.model-badge'); if(oldBadge) oldBadge.remove();
      var badge=document.createElement('span');
      badge.className='model-badge';
      badge.textContent=name.length>8?name.slice(0,8)+'…':name;
      b.appendChild(badge);
    }
    var prov = el.getAttribute('data-provider');
    var model = el.getAttribute('data-model');
    if(prov && model){
      _selectedModel = { provider: prov, model: model };
    } else {
      _selectedModel = name;
    }
    _setSessionModel(currentSession, _selectedModel);
    toast('已选择模型：'+name+'（仅当前会话）');
    closeMini();
    return;
  } else if(key==='connector'){
    // 连接器：选定连接器并在输入区渲染调用卡片（Fix #3/#5/#6）
    var kind=''; var c=null;
    for(var ci=0; ci<PV.octopConnectors.length; ci++){ if(PV.octopConnectors[ci].name===name){ kind=PV.octopConnectors[ci].kind; c=PV.octopConnectors[ci]; break; } }
    if(kind){ _selectedConnector = kind; renderConnectorChip(c); toast('已选择连接器：'+name); }
    closeMini();
    return;
  } else if(key==='skill'){
    // 真实切换「已启用技能」：加入/移除 _activeSkills，渲染 chip，并在发送时注入 system 提示
    var idx=_activeSkills.indexOf(name);
    if(idx>=0){ _activeSkills.splice(idx,1); el.classList.remove('active'); toast('已停用技能：'+name); }
    else { _activeSkills.push(name); el.classList.add('active'); toast('已启用技能：'+name); }
    var b2=document.getElementById('btnSkill'); if(b2) b2.classList.toggle('active', _activeSkills.length>0);
    renderSkillChips();
    return; // 保持弹窗打开，可继续勾选多个技能
  }
  closeMini();
}
/* 工具栏专家选择器：为所选专家创建/复用独立会话，并设为单专家注入对象 */
function pickItemExpert(id, el){
  var name = (el && el.querySelector('.t')) ? el.querySelector('.t').textContent : '';
  var prompt=''; var pid=id;
  if(!pid && name){
    var f=(window.AGENCY_PERSONAS||[]).find(function(x){ return (x.label||x.name)===name; });
    if(f) pid=f.id;
  }
  var ap=(window.AGENCY_PERSONAS||[]).find(function(x){ return x.id===pid; });
  if(ap){ prompt=ap.prompt||''; if(!name) name=(ap.label||ap.name||pid); }
  var expertName = name || (pid ? pid : '');
  // Issue #6 修正：选择单个专家时不再自动创建专家团，仅注入该专家的系统提示；
  // 专家团模式需通过「选择专家」弹窗的「专家团」tab 手动启用。
  // 为每个专家创建独立的顶层 agent 分组，会话归入该分组而非 default
  var agentId = 'exp-' + pid;
  var agent = ensureAgent(agentId, { name: expertName, icon: (ap && (ap.emoji||ap.icon)) || '🎯', expertId: pid });
  function afterSwitch(){
    currentAgent = agentId;
    _selectedExpert = { id:pid||'', name:expertName, prompt:prompt };
    // 互斥：停用工作流 & 专家团
    if(_cfg.extensions.workflow&&_cfg.extensions.workflow.enabled){ _cfg.extensions.workflow.enabled=false; _cfg.extensions.workflow.active=false; renderWorkflowBar(); }
    _cfg.extensions.team_enabled=false; renderTeamBar();
    var t=document.getElementById('chatTitle'); if(t) t.textContent=expertName;
    renderSelectedExpertBar();
    toast('已为专家「'+expertName+'」开启独立会话（发送时注入系统提示）');
  }
  // 仅复用「已归属本专家分组」的会话，确保每个专家拥有独立、稳定的会话窗口；
  // 不再按标题接管 default 会话（会导致专家会话混入默认分组、出现「未按专家分类」的观感）。
  var existing = _sessions.find(function(s){
    var owner = _sessionAgent[s.id] || 'default';
    return owner === agentId;
  });
  if(existing){
    switchSession(agentId, existing.id); afterSwitch();
  } else {
    fetch(apiUrl('/api/sessions'), { method:'POST', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ return r.json(); })
      .then(function(s){
        _sessions.unshift(s);
        currentSession=s.id; currentAgent=agentId;
        setSessionAgent(s.id, agentId);
        // 新专家分组默认展开，便于立即看到会话
        localStorage.setItem('hermes_rail_open_'+agentId, 'true');
        _openTabs.push(s.id); persistTabs();
        renderSessionTabs(); renderRail(); updateHeader();
        if(window.innerWidth<=768) closeRailDrawer();
        sendRaw('/title '+expertName); afterSwitch();
      })
      .catch(function(){ toast('创建会话失败'); });
  }
  closeMini();
}
function agencyIdByName(name){
  if(!window.AGENCY_PERSONAS) return '';
  var f=window.AGENCY_PERSONAS.find(function(x){ return (x.label||x.name)===name; });
  return f ? f.id : '';
}
/* 专家团专属会话分组：启用专家团时建立「专家团」标签卡片，会话归入该分组（与单专家分组一致） */
function enterTeamSession(){
  var team=_cfg.extensions.team||[];
  if(!team.length) return;   // 无成员不建分组
  var teamName=_cfg.extensions.team_name||'专家团';
  var agentId='team';
  var ag=ensureAgent(agentId, { name:teamName, icon:'👥' });
  if(ag && (ag.name!==teamName || ag.icon!=='👥')){ ag.name=teamName; ag.icon='👥'; saveAgents(); }
  function afterTeamSwitch(){
    currentAgent=agentId;
    var t=document.getElementById('chatTitle'); if(t) t.textContent=teamName;
  }
  // 复用已归属专家团分组的会话，否则新建一个并归入该分组
  var existing=_sessions.find(function(s){ return (_sessionAgent[s.id]||'default')===agentId; });
  if(existing){
    switchSession(agentId, existing.id); afterTeamSwitch();
  } else {
    fetch(apiUrl('/api/sessions'), { method:'POST', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ return r.json(); })
      .then(function(s){
        _sessions.unshift(s);
        currentSession=s.id; currentAgent=agentId;
        setSessionAgent(s.id, agentId);
        localStorage.setItem('hermes_rail_open_'+agentId, 'true');
        _openTabs.push(s.id); persistTabs();
        renderSessionTabs(); renderRail(); updateHeader();
        if(window.innerWidth<=768) closeRailDrawer();
        sendRaw('/title '+teamName); afterTeamSwitch();
      })
      .catch(function(){ toast('创建会话失败'); });
  }
}
/* 启用专家团模式（从工具栏弹窗触发）：开启委派并切到默认 agent，后续发送走专家团注入 */
function useExpertTeam(){
  var team=_cfg.extensions.team||[];
  // 专家团为空时不再只 toast 提示后退出，而是自动按部门各取 1 位组建一个跨领域团队，
  // 否则用户「启用专家团」后实际仍只走单专家分支。
  if(!team.length){
    if(typeof buildTeam==='function') buildTeam();
    team=_cfg.extensions.team||[];
    if(!team.length){
      // 连 buildTeam 都没有数据来源（AGENCY_PERSONAS 也没加载），给个明确提示
      toast('专家团为空且无专家数据，请先在「扩展→专家」加载专家库');
      return;
    }
  }
  _cfg.extensions.team_enabled=true;
  // 互斥：停用工作流
  if(_cfg.extensions.workflow&&_cfg.extensions.workflow.enabled){ _cfg.extensions.workflow.enabled=false; _cfg.extensions.workflow.active=false; renderWorkflowBar(); }
  if(!_cfg.extensions.toolsets) _cfg.extensions.toolsets={};
  _cfg.extensions.toolsets.delegation=true;
  saveConfig(); if(typeof renderTeam==='function') renderTeam(); renderTeamBar();
  // 清除单专家选择，让 system 注入走专家团分支；并为专家团建立专属「专家团」会话分组
  _selectedExpert=null; renderSelectedExpertBar();
  enterTeamSession();
  closeMini();
  toast('已启用专家团：'+team.length+' 人协作（发送消息即自动触发）');
}
/* 工具栏工作流选择器：从 mini popup 应用并激活工作流，互斥清除专家/专家团 */
function pickWorkflowFromMini(key){
  var nk=String(key||'').replace(/\\/g,'/');
  var p=(window.AO_WORKFLOW_PRESETS||[]).find(function(x){ return String(x.key).replace(/\\/g,'/')===nk; });
  if(!p){ toast('未找到工作流模板'); return; }
  _cfg.extensions.workflow = {
    key:p.key, name:p.name, description:p.description,
    enabled:true, active:true, concurrency:(p.concurrency||2), category:(p.category||''),
    inputs:(p.inputs||[]), steps:(p.steps||[])
  };
  // 互斥：清除单专家 & 专家团
  _selectedExpert=null; renderSelectedExpertBar();
  _cfg.extensions.team_enabled=false; renderTeamBar();
  if(!_cfg.extensions.toolsets) _cfg.extensions.toolsets={};
  _cfg.extensions.toolsets.delegation=true;
  saveConfig(); if(typeof renderWorkflow==='function') renderWorkflow(); if(typeof renderTeam==='function') renderTeam();
  // 工作流会话分组：建立专属分组，会话归入其中（与专家团分组同理）
  var wfAgentId = 'wf_' + p.key;
  ensureAgent(wfAgentId, { name: p.name, icon: '🛠️' });
  var wfExisting = _sessions.find(function(s){ return (_sessionAgent[s.id]||'default')===wfAgentId; });
  if(wfExisting){
    switchSession(wfAgentId, wfExisting.id);
  } else {
    fetch(apiUrl('/api/sessions'), { method:'POST', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ return r.json(); })
      .then(function(s){
        _sessions.unshift(s);
        currentSession=s.id; currentAgent=wfAgentId;
        setSessionAgent(s.id, wfAgentId);
        localStorage.setItem('hermes_rail_open_'+wfAgentId, 'true');
        _openTabs.push(s.id); persistTabs();
        renderSessionTabs(); renderRail(); updateHeader();
      })
      .catch(function(){ toast('创建会话失败'); });
  }
  var t=document.getElementById('chatTitle'); if(t) t.textContent=p.name;
  renderWorkflowBar();
  closeMini();
  toast('已启用工作流：'+p.name+'（发送消息即自动触发）');
}
function clearWorkflowFromMini(){
  _cfg.extensions.workflow = { enabled:false, active:false, key:'', name:'', concurrency:2, category:'', inputs:[], steps:[] };
  saveConfig(); if(typeof renderWorkflow==='function') renderWorkflow();
  renderWorkflowBar();
  var t=document.getElementById('chatTitle'); if(t) t.textContent='默认主力助手';
  toast('已停用工作流');
  // 刷新 mini popup 内容
  if(activePanel==='expert') document.getElementById('popupBody').innerHTML=buildMiniPopupBody('expert', buildMiniData().expert);
}
/* 工具栏智能体选择器：从 mini popup 切换默认角色（persona），互斥清除专家/专家团/工作流 */
function pickPersonaFromMini(id){
  var p=allPersonas()[id]; if(!p){ toast('未找到角色'); return; }
  selectPersona(id);
  // 互斥：清除单专家 & 专家团 & 工作流
  if(_cfg.extensions.workflow&&_cfg.extensions.workflow.enabled){ _cfg.extensions.workflow.enabled=false; _cfg.extensions.workflow.active=false; renderWorkflowBar(); }
  _cfg.extensions.team_enabled=false; renderTeamBar();
  saveConfig();
  currentAgent='default';
  var t=document.getElementById('chatTitle'); if(t) t.textContent=p.label||id;
  var sub=document.getElementById('chatSubtitle'); if(sub) sub.textContent=(p.label||id)+' · 默认角色';
  closeMini();
  toast('已切换默认角色：'+(p.label||id));
}
/* 工作流状态栏（显示在聊天区上方，类似 selectedExpertBar） */
function renderWorkflowBar(){
  var bar=document.getElementById('workflowBar');
  var wf=_cfg.extensions.workflow;
  var active=!!(wf&&wf.enabled&&wf.steps&&wf.steps.length);
  if(!bar){
    if(!active) return;
    var comp=document.getElementById('chatComposer'); if(!comp) return;
    bar=document.createElement('div'); bar.id='workflowBar'; bar.className='selected-expert-bar';
    comp.parentNode.insertBefore(bar, comp);
  }
  if(!active){ bar.style.display='none'; return; }
  bar.style.display='flex';
  bar.innerHTML='<span class="seb-label">当前工作流：</span><strong>🎛️ '+esc(wf.name||'')+'</strong><span style="color:var(--text3);font-size:12px">'+(wf.steps?wf.steps.length:0)+' 个步骤 · 发送即触发</span><button class="action sm" onclick="clearWorkflowFromMini()">停用</button>';
}
/* 专家团状态栏（显示在聊天区上方，与工作流状态栏一致）：
   当前专家团：成员名、… · N 个角色 · 发送即触发 + 停用按钮 */
function renderTeamBar(){
  var bar=document.getElementById('teamBar');
  var team=_cfg.extensions.team||[];
  // 与工作流互斥：注入优先级工作流 > 专家团，工作流激活时不显示专家团栏
  var wf=_cfg.extensions.workflow;
  var wfActive=!!(wf&&wf.enabled&&wf.steps&&wf.steps.length);
  var active=!!(_cfg.extensions.team_enabled&&team.length&&!wfActive);
  if(!bar){
    if(!active) return;
    var comp=document.getElementById('chatComposer'); if(!comp) return;
    bar=document.createElement('div'); bar.id='teamBar'; bar.className='selected-expert-bar';
    comp.parentNode.insertBefore(bar, comp);
  }
  if(!active){ bar.style.display='none'; return; }
  bar.style.display='flex';
  var names=team.map(function(m){ return m.name||m.id; }).join('、');
  bar.innerHTML='<span class="seb-label">当前专家团：</span><strong style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(names)+'">👥 '+esc(names)+'</strong><span style="color:var(--text3);font-size:12px;white-space:nowrap">'+team.length+' 个角色 · 发送即触发</span><button class="action sm" onclick="disableTeamFromBar()">停用</button>';
}
/* 从状态栏停用专家团：关闭 team_enabled 并同步扩展页开关 */
function disableTeamFromBar(){
  _cfg.extensions.team_enabled=false;
  setToggle('teamEnabledToggle', false);
  saveConfig(); if(typeof renderTeam==='function') renderTeam(); renderTeamBar();
  toast('已停用专家团');
}
/* 连接器激活卡片（渲染在输入区上方，best-effort 调用首个工具） */
function renderConnectorChip(c){
  var comp=document.getElementById('chatComposer'); if(!comp) return;
  var box=document.getElementById('connectorChip');
  if(!box){ box=document.createElement('div'); box.id='connectorChip'; box.className='connector-chip'; comp.insertBefore(box, comp.firstChild); }
  box.style.display='flex';
  box.innerHTML='<span class="cc-ico">'+c.icon+'</span><span class="cc-name">'+esc(c.name)+'</span>'+
    '<button class="cc-btn" onclick="invokeSelectedConnector()">调用</button>'+
    '<button class="cc-x" onclick="clearConnectorChip()">×</button>';
}
function clearConnectorChip(){ var box=document.getElementById('connectorChip'); if(box){ box.style.display='none'; box.innerHTML=''; } _selectedConnector=''; }
function invokeSelectedConnector(){
  if(!_selectedConnector) return;
  var c=PV.octopConnectors.find(function(x){ return x.kind===_selectedConnector; });
  if(!c || !c.tools || !c.tools.length){ toast('该连接器无可用工具，请先在「连接器」页配置'); return; }
  var tool=c.tools[0]; var args={};
  toast('正在调用 '+c.name+' · '+tool.name+'…');
  apiPost('/api/connectors/'+encodeURIComponent(_selectedConnector)+'/call', { tool:tool.name, args:args })
    .then(function(r){
      if(r && (r.ok || r.result!=null)){
        var txt = (typeof r.result==='string') ? r.result : JSON.stringify(r.result,null,2);
        appendSystemMessage(c.name+' · '+tool.name+'：\n'+txt);
      } else if(r && r.error){ toast('调用失败：'+r.error); }
      else { toast('调用完成（无返回）'); }
    })
    .catch(function(){
      // 后端无此端点 / 连接器未配置：优雅降级为发送引用消息
      toast('该连接器需先在「连接器」页配置并保存');
      if(currentSession) sendRaw('请通过已配置的 '+c.name+' 连接器处理以下请求：');
    });
}
var _selectedModelMap = (function(){ try{ var s=localStorage.getItem('hermes_selected_model_map'); return s?JSON.parse(s):{}; }catch(e){ return {}; } })();
// 无当前会话时选择的模型暂存于此，会话创建后自动绑定（修复：新建会话前选模型被丢弃的问题）
var _pendingModel = '';
function _getSessionModel(sid){ return _selectedModelMap[sid||currentSession] || ''; }
function _setSessionModel(sid, val){ if(!sid) sid=currentSession; if(!sid){ if(val) _pendingModel = val; return; } if(val){ _selectedModelMap[sid]=val; } else { delete _selectedModelMap[sid]; } try{ localStorage.setItem('hermes_selected_model_map', JSON.stringify(_selectedModelMap)); }catch(e){} }
// 会话创建成功后调用：把暂存的模型绑定到新会话（若该会话尚未绑定过模型）
function _applyPendingModel(sid){
  if(_pendingModel && sid && !_selectedModelMap[sid]){
    _selectedModelMap[sid] = _pendingModel;
    _pendingModel = '';
    try{ localStorage.setItem('hermes_selected_model_map', JSON.stringify(_selectedModelMap)); }catch(e){}
    _syncModelBtn();
  }
}
function clearSessionModel(){
  _pendingModel = '';
  _setSessionModel(currentSession, '');
  _selectedModel = '';
  var b=document.getElementById('btnModel');
  if(b){
    b.setAttribute('data-tip','选择模型'); b.classList.remove('active');
    var oldBadge = b.querySelector('.model-badge'); if(oldBadge) oldBadge.remove();
  }
  toast('已清除模型选择，将使用默认配置');
  closeMini();
}
// 兼容旧版全局 key 迁移
var _selectedModel = (function(){ try{ var s=localStorage.getItem('hermes_selected_model'); if(s){ var v=JSON.parse(s); localStorage.removeItem('hermes_selected_model'); return v; } return ''; }catch(e){ return ''; } })();
if(_selectedModel && currentSession){ _setSessionModel(currentSession, _selectedModel); _selectedModel=''; }
function persistSelectedModel(){ _setSessionModel(currentSession, _selectedModel); }
var _activeSkills = [];   // 当前会话已启用的技能（名称列表），发送时注入 system 提示
var _selectedExpert = null;     // 单专家注入对象 {id,name,prompt}（决策 3，随会话）
var _selectedConnector = '';    // 当前选中的连接器 kind（字符串）
var _wfSteps = [];              // 工作流 DAG 编辑中的步骤工作副本
function renderSkillChips(){
  var box=document.getElementById('skillChips'); if(!box) return;
  if(!_activeSkills.length){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='flex';
  box.innerHTML = _activeSkills.map(function(n){
    return '<span class="skill-chip" onclick="removeSkill(\''+esc(n).replace(/'/g,"\\'")+'\')">'+esc(n)+' <span class="x">×</span></span>';
  }).join('');
}
function removeSkill(n){
  var idx=_activeSkills.indexOf(n); if(idx>=0) _activeSkills.splice(idx,1);
  var b2=document.getElementById('btnSkill'); if(b2) b2.classList.toggle('active', _activeSkills.length>0);
  renderSkillChips();
}
function pickQuick(cmd){ closeMini(); handleSlashCommand(cmd); }
function handleSlashCommand(cmd){
  if(!cmd || cmd.charAt(0)!=='/'){ sendRaw(cmd); return; }
  var parts = cmd.split(' ');
  var base = parts[0].toLowerCase();
  var arg = parts.slice(1).join(' ').trim();
  if(base==='/new'){
    newSession();
    return;
  }
  if(base==='/stop'){
    chatStop();
    toast('已停止当前生成');
    return;
  }
  if(base==='/reset'){
    if(currentSession){
      fetch(apiUrl('/api/sessions/'+encodeURIComponent(currentSession)), { method:'DELETE', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
        .then(function(){ newSession(); toast('已重置当前会话'); })
        .catch(function(){ toast('重置失败'); });
    } else { newSession(); }
    return;
  }
  if(base==='/status'){
    var statusMsg = '当前状态：';
    statusMsg += 'Gateway ' + (_services.gateway?'运行中':'未启动') + '，';
    statusMsg += 'Dashboard ' + (_services.dashboard?'运行中':'未启动') + '；';
    statusMsg += '当前模型 ' + (_cfg.active_provider||'自动') + ' · ' + _getActiveModelName() + '；';
    statusMsg += '角色 ' + (_persona||'default') + '。';
    appendSystemMessage(statusMsg);
    return;
  }
  if(base==='/help'){
    appendSystemMessage('可用命令（与 Hermes 消息网关一致）：/new 新对话、/reset 重置、/stop 停止生成、/retry 重生成、/undo 撤销、/compress 压缩上下文、/title 设置标题、/status 状态、/model 切换模型、/provider 提供方、/personality 人格、/reasoning 推理、/usage 用量、/insights 洞察、/plan 计划、/reload-mcp 重载MCP、/yolo YOLO、/help 帮助。未在此列出的命令将直接转发给 Hermes 网关按斜杠命令执行。');
    return;
  }
  // 其余为 Hermes 真实斜杠命令，原样转发给网关执行（不加“执行命令：”前缀，避免被当作普通文本）
  sendRaw(cmd);
}
function appendSystemMessage(text){
  var body=document.getElementById('chatBody'); if(!body) return;
  var div=document.createElement('div'); div.className='system-tip'; div.textContent=text;
  body.appendChild(div); body.scrollTop=body.scrollHeight;
}

/* ============================ Router ============================ */
function switchPage(name){
  document.querySelectorAll('.nav-btn').forEach(function(b){ b.classList.remove('active'); });
  var btn=Array.from(document.querySelectorAll('.nav-btn')).find(function(b){ return b.getAttribute('onclick') && b.getAttribute('onclick').includes("'"+name+"'"); });
  if(btn) btn.classList.add('active');
  document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });
  var p=document.getElementById('page-'+name); if(p) p.classList.add('active');
  var rail=document.getElementById('chatRail');
  if(rail) rail.classList.toggle('hidden', name!=='chat');
  if(name==='connectors') renderConnectors();
  if(name==='comm') renderChannels();
  if(name==='cron') renderCronJobs();
  if(name==='memory') renderMemoryPage();
  if(name==='learning') renderLearning();
  if(name==='usage') renderUsagePage();
  if(name==='overview') renderOverview();
  if(name==='models') renderProviders();
  if(name==='extensions') renderExtensions();
  if(name==='updates'){ checkHermesUpdate(); checkAppUpdate(); }
  if(name==='settings') renderSettings();
  if(name!=='chat') hideScrollBtn();   // 回到底部按钮仅用于聊天页（Issue #10）
}

/* ============================ Theme ============================ */
function setTheme(mode){
  currentTheme=mode;
  document.body.classList.remove('theme-light','theme-dark');
  if(mode==='light'){ document.body.classList.add('theme-light'); }
  else if(mode==='dark'){ document.body.classList.add('theme-dark'); }
  else {
    if(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.body.classList.add('theme-dark');
    else document.body.classList.add('theme-light');
  }
  document.querySelectorAll('.glob-btn').forEach(function(b){ b.classList.remove('active'); });
  var map={'auto':'btnThemeAuto','light':'btnThemeLight','dark':'btnThemeDark'};
  var id=map[mode]; if(id){ var b=document.getElementById(id); if(b) b.classList.add('active'); }
  try { localStorage.setItem('fnos-theme-mode', mode); } catch(e){}
}

/* ============================ 概览 ============================ */
var _connecting = false;  // 重启/启动/停止进行中，保持「连接中」琥珀态，避免闪烁离线
function applyServiceState(s){
  var gw = !!(s.gateway && s.gateway.running);
  var db = !!(s.dashboard && s.dashboard.running);
  _services = { gateway:gw, dashboard:db };
  // 动作进行中且服务尚未就绪：保持连接中（琥珀），不要闪离线
  if(_connecting && !(gw||db)){
    var b0=document.getElementById('ovStatusBadge'); var t0=document.getElementById('ovStatusText');
    if(b0) b0.className='ov-status connecting';
    if(t0) t0.textContent='连接中…';
    var bd0=document.getElementById('brandDot'); if(bd0) bd0.className='brand-dot connecting';
    return;
  }
  _connecting = false;
  var badge=document.getElementById('ovStatusBadge');
  var txt=document.getElementById('ovStatusText');
  if(badge) badge.className='ov-status '+(gw||db?'on':'off');
  if(txt) txt.textContent=(gw||db)?'运行中':'已停止';
  var brandDot=document.getElementById('brandDot');
  if(brandDot) brandDot.className='brand-dot '+(gw?'online':(db?'connecting':'offline'));
  setToggle('gwToggle', gw); setToggle('dbToggle', db);
  var gsp=document.getElementById('gwStateText'); if(gsp) gsp.textContent= gw?'运行中':'未启动';
  var dsp=document.getElementById('dbStateText'); if(dsp) dsp.textContent= db?'运行中':'未启动';
  // 端口随服务端配置动态显示（v0.20.65 端口迁移到 8742/9219，避免与同机 hermes-studio 的 8642 冲突）
  var gport = (s.gateway && s.gateway.port) || 8742;
  var dport = (s.dashboard && s.dashboard.port) || 9219;
  var gpe=document.getElementById('gwPort'); if(gpe) gpe.textContent=gport;
  var dpe=document.getElementById('dbPort'); if(dpe) dpe.textContent=dport;
  // 系统信息：统一走 ID，避免 querySelectorAll 索引错位；优先使用服务端已格式化的 s.uptime
  var upEl=document.getElementById('sysUptime');
  if(upEl){
    if(s.uptime!=null){ upEl.textContent=s.uptime; }
    else if(s.uptimeMs!=null){ upEl.textContent=fmtUptime(s.uptimeMs); }
  }
  var memEl=document.getElementById('sysMem');
  if(memEl && s.memoryKB!=null){ memEl.textContent=Math.round(s.memoryKB/1024)+' MB'; }
  var hvEl=document.getElementById('sysHermesVer');
  if(hvEl && s.gateway && s.gateway.version){ hvEl.textContent=fmtHermesVer(s.gateway.version, s.hermes_version_date); }
  var avEl=document.getElementById('sysAppVer');
  if(avEl && s.app_version){ avEl.textContent=s.app_version; }
  if(s.app_version){ window.__APP_VER__ = s.app_version; }
  // 顶栏与更新页当前版本同步
  var brand=document.getElementById('brandVer');
  if(brand && s.app_version){ brand.textContent='v'+s.app_version; }
  var hermCur=document.getElementById('hermesCurrent');
  if(hermCur && s.gateway && s.gateway.version){ hermCur.textContent=fmtHermesVer(s.gateway.version, s.hermes_version_date); }
  var appCur=document.getElementById('appCurrent');
  if(appCur && s.app_version){ appCur.textContent='v'+s.app_version; }
}
function renderOverview(){
  apiGet('/api/status').then(function(s){
    if(!s || s.error){ setStatusOffline(); return; }
    applyServiceState(s);
    // 初始化日志过滤区折叠状态（手机端默认收起，电脑端始终展开）
    initLogFilterToggle();
    // 同步多会话标签栏可见性（仅左侧折叠时显示）
    syncSessionTabsVisibility();
    // 默认加载 Monitor 日志（仅首次）
    if(!_logInited){ _logInited=true; setTimeout(function(){ appendLog('monitor','Monitor 日志'); }, 100); }
  }).catch(function(){ setStatusOffline(); });
}
// 轻量级状态轮询：只更新顶栏状态点与服务卡片，不重渲染日志/系统信息区块（避免打断日志查看）
function tickStatus(){
  apiGet('/api/status').then(function(s){
    if(!s || s.error){ if(!_connecting) setStatusOffline(); return; }
    applyServiceState(s);
  }).catch(function(){ if(!_connecting) setStatusOffline(); });
}
function setStatusOffline(){
  var badge=document.getElementById('ovStatusBadge'); var txt=document.getElementById('ovStatusText');
  if(badge) badge.className='ov-status off';
  if(txt) txt.textContent='离线';
  var brandDot=document.getElementById('brandDot'); if(brandDot) brandDot.className='brand-dot offline';
  setToggle('gwToggle',false); setToggle('dbToggle',false);
  var gsp=document.getElementById('gwStateText'); if(gsp) gsp.textContent='未启动';
  var dsp=document.getElementById('dbStateText'); if(dsp) dsp.textContent='未启动';
}
function fmtHermesVer(ver, date){
  if(!ver || ver==='--') return ver;
  if(/\(\d{4}\.\d{1,2}\.\d{1,2}\)/.test(ver)) return ver;
  if(date && ver.indexOf(date)===-1) return ver+' ('+date+')';
  return ver;
}
function fmtUptime(ms){
  // 服务端 uptimeMs 为毫秒；统一转换为秒再格式化
  var sec = Math.floor((Number(ms)||0)/1000);
  var d=Math.floor(sec/86400); sec%=86400;
  var h=Math.floor(sec/3600); sec%=3600;
  var m=Math.floor(sec/60);
  var parts=[];
  if(d>0) parts.push(d+'天');
  if(h>0) parts.push(h+'小时');
  parts.push(m+'分钟');
  return parts.join(' ');
}
function setToggle(id, on){ var t=document.getElementById(id); if(t) t.classList.toggle('on', !!on); }
function toggleService(name){
  var running = name==='dashboard' ? _services.dashboard : _services.gateway;
  if(running){ stopServices(name); } else { startServices(name); }
}
function startServices(which){
  var path = which==='dashboard' ? '/api/dashboard/start' : '/api/start';
  _connecting = true;
  apiPost(path, {}).then(function(r){
    if(r && r.error){ toast('启动失败：'+r.error); _connecting=false; }
    else { toast('正在启动'+(which?(' '+which):'服务')); }
    tickStatus();
  }).catch(function(e){ toast('启动请求失败：'+e.message); _connecting=false; });
}
function stopServices(which){
  var path = which==='dashboard' ? '/api/dashboard/stop' : '/api/stop';
  _connecting = true;
  apiPost(path, {}).then(function(r){
    if(r && r.error){ toast('停止失败：'+r.error); _connecting=false; }
    else { toast('正在停止'+(which?(' '+which):'服务')); }
    tickStatus();
  }).catch(function(e){ toast('停止请求失败：'+e.message); _connecting=false; });
}
function restartServices(){
  _connecting = true;
  apiPost('/api/restart', {}).then(function(r){ if(r && r.error){ toast('重启失败：'+r.error); _connecting=false; } else toast('正在重启服务'); tickStatus(); }).catch(function(e){ toast('重启请求失败：'+e.message); _connecting=false; });
}
function pollStatus(){
  var tries=0;
  (function check(){
    tries++;
    apiGet('/api/status').then(function(s){
      if(s && !s.error){
        var gw=!!(s.gateway&&s.gateway.running), db=!!(s.dashboard&&s.dashboard.running);
        if(gw||db||tries>=15){ _services={gateway:gw,dashboard:db}; renderOverview(); }
        else setTimeout(check, 1000);
      } else if(tries<15){ setTimeout(check,1000); }
    }).catch(function(){ if(tries<15) setTimeout(check,1000); });
  })();
}
function openDashboard(){ window.open(BASE + '/proxy/dashboard/', '_blank'); }
function refreshSysInfo(){
  apiGet('/api/status').then(function(s){
    if(!s || s.error) return;
    var upEl=document.getElementById('sysUptime');
    if(upEl){
      if(s.uptime!=null){ upEl.textContent=s.uptime; }
      else if(s.uptimeMs!=null){ upEl.textContent=fmtUptime(s.uptimeMs); }
    }
    var memEl=document.getElementById('sysMem');
    if(memEl && s.memoryKB!=null){ memEl.textContent=Math.round(s.memoryKB/1024)+' MB'; }
  }).catch(function(){});
}
// 日志查看器状态：与 dashboard/logs 对齐（来源、级别、组件、行数、关键词）
var _logState = {
  source: 'monitor',
  level: 'all',
  component: 'all',
  lines: 100,
  keyword: '',
  rawLines: [],
  titleMap: { monitor:'Monitor 日志', agent:'Agent 日志', gui:'GUI 日志', error:'错误日志', gateway:'Gateway 日志', gateway_restart:'Gateway 重启记录', gateway_close:'Gateway 关闭诊断', gateway_exit:'Gateway 退出诊断', all:'全部日志' },
  fileMap: { monitor:'hermes.log', agent:'agent.log', gui:'gui.log', error:'errors.log', gateway:'gateway.log', gateway_restart:'gateway-restart.log', gateway_close:'gateway-shutdown-diag.log', gateway_exit:'gateway-exit-diag.log' },
  sourceFiles: {
    monitor: ['monitor'], agent: ['agent'], gateway: ['gateway'], error: ['error'], gui: ['gui'],
    gateway_restart: ['gateway_restart'], gateway_close: ['gateway_close'], gateway_exit: ['gateway_exit'],
    all: ['monitor','agent','gateway','error','gui','gateway_restart','gateway_close','gateway_exit']
  }
};
function setLogSource(s){ _logState.source=s||'monitor'; applyLogFilters(true); }
function setLogLevel(l){ _logState.level=l||'all'; applyLogFilters(false); }
function setLogComponent(c){ _logState.component=c||'all'; applyLogFilters(false); }
function setLogLines(n){ _logState.lines=parseInt(n)||100; applyLogFilters(true); }
function clearLogKeyword(){ var k=document.getElementById('logKeyword'); if(k) k.value=''; _logState.keyword=''; applyLogFilters(false); }

// 手机端折叠/展开日志过滤区（电脑端无按钮，过滤区始终可见）
function toggleLogFilters(){
  var bar=document.getElementById('ovLogBar');
  var btn=document.getElementById('ovLogFilterToggle');
  var lbl=document.getElementById('ovLogFilterToggleLabel');
  if(!bar||!btn) return;
  var open=!bar.classList.contains('open');
  bar.classList.toggle('open', open);
  btn.classList.toggle('on', open);
  if(lbl) lbl.textContent = open ? '收起日志过滤' : '显示日志过滤';
  try { localStorage.setItem('hermes_log_filter_open', open?'true':'false'); } catch(e){}
}
// 启动时根据 localStorage + 屏幕宽度决定初始状态
function initLogFilterToggle(){
  var bar=document.getElementById('ovLogBar');
  var btn=document.getElementById('ovLogFilterToggle');
  var lbl=document.getElementById('ovLogFilterToggleLabel');
  if(!bar||!btn) return;
  var open=false;
  try { open = localStorage.getItem('hermes_log_filter_open')==='true'; } catch(e){}
  bar.classList.toggle('open', open);
  btn.classList.toggle('on', open);
  if(lbl) lbl.textContent = open ? '收起日志过滤' : '显示日志过滤';
}
function applyLogFilters(refetch){
  var k=document.getElementById('logKeyword');
  _logState.keyword = k ? k.value : '';
  updateLogFilterUI();
  if(refetch){ fetchLogLines(); return; }
  renderLogLines();
}
function updateLogFilterUI(){
  document.querySelectorAll('[data-log-source]').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-log-source')===_logState.source); });
  document.querySelectorAll('[data-log-level]').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-log-level')===_logState.level); });
  document.querySelectorAll('[data-log-comp]').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-log-comp')===_logState.component); });
  document.querySelectorAll('[data-log-lines]').forEach(function(b){ b.classList.toggle('active', parseInt(b.getAttribute('data-log-lines'))===_logState.lines); });
}
function fetchLogLines(){
  var pre=document.getElementById('logPre'); if(!pre) return;
  pre.innerHTML='[ 加载日志中… ]';
  var files = _logState.sourceFiles[_logState.source] || [_logState.source];
  var pending = files.length;
  var all = [];
  files.forEach(function(tag){
    var file = _logState.fileMap[tag] || 'hermes.log';
    fetch(apiUrl('/api/logs/read?file='+encodeURIComponent(file)+'&lines='+encodeURIComponent(_logState.lines)), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ return r.json(); })
      .then(function(d){ (d && d.lines||[]).forEach(function(l){ all.push({tag:tag, line:l}); }); })
      .catch(function(){})
      .finally(function(){ pending--; if(pending===0){ _logState.rawLines=all; renderLogLines(); } });
  });
}
function detectLogLevel(line){
  var m = String(line).match(/\b(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\b/i);
  if(!m) return '';
  var lvl = m[1].toLowerCase();
  if(lvl==='warn') return 'warning';
  if(lvl==='critical' || lvl==='fatal') return 'error';
  return lvl;
}
function detectLogComponent(line){
  var s = String(line);
  var m = s.match(/\b(?:DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+([a-zA-Z0-9_\.]+)/i);
  var logger = m ? m[1].toLowerCase() : '';
  if(logger.indexOf('gateway')>=0) return 'gateway';
  if(logger.indexOf('agent')>=0) return 'agent';
  if(logger.indexOf('cron')>=0) return 'cron';
  if(logger.indexOf('cli')>=0 || logger.indexOf('hermes_cli')>=0) return 'cli';
  if(logger.indexOf('tool')>=0 || /\b(tool_|plugin|mcp)\b/i.test(s)) return 'tools';
  return '';
}
function renderLogLines(){
  var pre=document.getElementById('logPre'); if(!pre) return;
  var titleEl=document.getElementById('logBoxTitle'); if(titleEl) titleEl.textContent = _logState.titleMap[_logState.source] || '日志';
  var kwLower = (_logState.keyword||'').toLowerCase();
  var filtered = _logState.rawLines.filter(function(item){
    var lvl = detectLogLevel(item.line);
    var comp = detectLogComponent(item.line) || item.tag;
    if(_logState.level!=='all' && lvl!==_logState.level) return false;
    if(_logState.component!=='all' && comp!==_logState.component) return false;
    if(kwLower && String(item.line).toLowerCase().indexOf(kwLower)<0) return false;
    return true;
  });
  if(!filtered.length){ pre.innerHTML = '[ 无匹配日志 ]'; pre.scrollTop = 0; return; }
  // 倒序：最新日志排在最上方（Issue：日志排版用倒序）
  pre.innerHTML = filtered.slice().reverse().map(function(item){
    var lvl = detectLogLevel(item.line);
    return lvl ? '<span class="log-'+lvl+'">'+esc(item.line)+'</span>' : esc(item.line);
  }).join('\n');
  pre.scrollTop = 0;
}
function appendLog(tag, msg){
  // 兼容旧入口：设置来源并重新拉取
  _logState.source = tag || 'monitor';
  var k=document.getElementById('logKeyword'); if(k) k.value='';
  _logState.keyword='';
  applyLogFilters(true);
}
function clearLog(){
  var files = _logState.sourceFiles[_logState.source] || [_logState.source];
  files.forEach(function(tag){
    var file = _logState.fileMap[tag] || 'hermes.log';
    apiPost('/api/logs/clear', { file: file }).catch(function(){});
  });
  var pre=document.getElementById('logPre'); if(pre) pre.textContent='';
}
function toggleLogRefresh(){
  var t=document.getElementById('logRefreshToggle');
  if(!t) return;
  t.classList.toggle('on');
  if(t.classList.contains('on')){
    startLogStream();
  } else {
    stopLogStream();
  }
}
function startLogStream(){
  stopLogStream();
  try {
    _logStream = new EventSource(apiUrl('/api/logs'));
    _logStream.addEventListener('log', function(e){ if(e.data){ var pre=document.getElementById('logPre'); if(pre){ pre.textContent = (pre.textContent?pre.textContent+'\n':'')+e.data; pre.scrollTop=pre.scrollHeight; } } });
    _logStream.onerror = function(){ stopLogStream(); };
  } catch(e){ toast('日志流不可用'); }
}
function stopLogStream(){ if(_logStream){ try{_logStream.close();}catch(e){} _logStream=null; } }

/* ============================ 模型 / Provider ============================ */
function loadConfig(){
  return apiGet('/api/config').then(function(cfg){
    if(cfg && !cfg.error){
      _cfg = cfg;
      // hermes 是否已配置模型（服务端判定：config.yaml 含 model/providers 段）
      window.__hermesConfigured = (cfg.hermes_configured !== false);
      if(!_cfg.extensions) _cfg.extensions = { toolsets:{}, mcp_servers:[], skills_dirs:[], persona:'default', memory:{enabled:true,char_limit:2200}, team:[], team_name:'' };
      if(!_cfg.extensions.toolsets) _cfg.extensions.toolsets = {};
      if(!_cfg.extensions.memory) _cfg.extensions.memory = {enabled:true,char_limit:2200};
      if(!_cfg.extensions.memory.policy) _cfg.extensions.memory.policy = {};
      if(!_cfg.extensions.skills_config) _cfg.extensions.skills_config = {};
      if(!_cfg.extensions.tools_config) _cfg.extensions.tools_config = {};
      if(!_cfg.extensions.team_enabled) _cfg.extensions.team_enabled = false;
      if(!_cfg.extensions.expert_favorites) _cfg.extensions.expert_favorites = [];
      if(!_cfg.extensions.external_resources) _cfg.extensions.external_resources = {};
      if(!_cfg.extensions.workflow) _cfg.extensions.workflow = { enabled:false, active:false };
      else if(_cfg.extensions.workflow.active == null) _cfg.extensions.workflow.active = false;
      if(!_cfg.extensions.tools_config) _cfg.extensions.tools_config = {};
      if(_cfg.extensions.team_enabled===undefined) _cfg.extensions.team_enabled = false;
      if(!_cfg.extensions.expert_favorites) _cfg.extensions.expert_favorites = [];
      if(_cfg.extensions.persona===undefined) _cfg.extensions.persona = 'default';
      if(!_cfg.extensions.persona) _cfg.extensions.persona = 'default';
      if(!_cfg.extensions.external_resources) _cfg.extensions.external_resources = { superpowers_zh:{enabled:false,path:'skills/superpowers-zh'}, ai_coding_guide:{enabled:false,url:'https://github.com/jnMetaCode/ai-coding-guide'}, shellward:{enabled:false,mode:'audit',mcp:{command:'shellward',args:['shellward-mcp']}} };
      if(!_cfg.extensions.memory.policy) _cfg.extensions.memory.policy = {};
      if(!_cfg.extensions.workflow || typeof _cfg.extensions.workflow!=='object') _cfg.extensions.workflow = { enabled:false, active:false, key:'', name:'', concurrency:2, category:'', inputs:[], steps:[] };
      if(_cfg.extensions.workflow.active===undefined) _cfg.extensions.workflow.active = false;
      if(_cfg.extensions.persona)       _persona = _cfg.extensions.persona;
      // Issue #7：清缓存/换浏览器后，从服务端恢复会话角色分组与会话→分组映射
      // Issue #7：始终以服务端持久化的角色分组与会话→分组映射为准（清缓存/换浏览器后恢复，
      // 且不被本地可能已失效的旧值遮蔽，否则会出现「所有会话挤在默认分组」的观感）。
      if(Array.isArray(_cfg.extensions.agents) && _cfg.extensions.agents.length){
        _agents = _cfg.extensions.agents.slice();
        if(!_agents.some(function(a){ return a.id==='default'; })) _agents.unshift({ id:'default', name:'默认主力助手', icon:'🤖', expertId:null });
      }
      // 未配置模型时强制只保留默认分组：残留的专家/团队分组无意义，
      // 且 saveAgents 回写 localStorage 后会顺便清掉浏览器端的旧残留
      if(_cfg.hermes_configured === false){
        _agents = [{ id:'default', name:'默认主力助手', icon:'🤖', expertId:null }];
        _sessionAgent = {};
      }
      if(_cfg.extensions.session_agent && typeof _cfg.extensions.session_agent==='object'){
        _sessionAgent = _cfg.extensions.session_agent;
      }
      renderConfigBanner();
      _settingsLoaded = true;
      applySettingsToggles();
    } else {
      toast('读取配置失败：'+(cfg&&cfg.error||'未知'));
    }
    return _cfg;
  }).catch(function(e){ toast('读取配置失败：'+e.message); return _cfg; });
}
/* 聊天页横幅：hermes 未配置模型时提示引导（点击跳「模型」页） */
function renderConfigBanner(){
  var chat = document.getElementById('page-chat');
  if(!chat) return;
  var old = document.getElementById('modelConfigBanner');
  if(old && old.parentNode) old.parentNode.removeChild(old);
  if(window.__hermesConfigured !== false) return;
  var b = document.createElement('div');
  b.id = 'modelConfigBanner';
  b.style.cssText = 'margin:8px 14px 0;padding:10px 14px;border-radius:10px;background:var(--warn-banner-bg);border:1px solid var(--warn-banner-border);color:var(--warn-banner-text);font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;z-index:5';
  b.innerHTML = '<span>⚠ 尚未配置模型服务，聊天暂时不可用。请先添加一个模型供应商并填写 API Key。</span>' +
    '<button onclick="switchPage(\'models\')" style="margin-left:auto;padding:5px 12px;border-radius:8px;border:1px solid var(--warn-banner-border);background:transparent;color:var(--warn-banner-text);cursor:pointer;font-size:12px;white-space:nowrap">去配置模型 →</button>';
  var bodyEl = chat.querySelector('.chat-body');
  chat.insertBefore(b, bodyEl || chat.firstChild);
}
function saveConfig(){
  apiPost('/api/config', _cfg).catch(function(e){ console.error('saveConfig failed', e); });
}
function renderProviders(){
  var grid=document.getElementById('providerGrid'); if(!grid) return;
  var providers = _cfg.providers || [];
  if(!providers.length){ grid.innerHTML='<div class="empty-state">'+(window.__hermesConfigured===false?'⚠ 尚未配置模型服务：点击右上角「添加」，选择一个模型供应商并填写 API Key 后即可使用。':'暂无 Provider，点击右上角添加。')+'</div>'; return; }
  var fallback = _cfg.fallback_providers || [];
  grid.innerHTML = providers.map(function(p, i){
    var pname = p.name || p.id || '未命名';
    var isActive = (_cfg.active_provider === pname);
    var isFallback = fallback.indexOf(pname) >= 0;
    var enabled = (p.models || []).filter(function(m){ return m.enabled!==false; });
    var modelText = esc(p.model) || (enabled.length ? esc(enabled[0].id || enabled[0].name || '') : '未选择模型');
    var temp = p.temperature != null ? p.temperature : '-';
    var maxT = p.max_tokens != null ? p.max_tokens : '-';
    var key = p.api_key || p.api_key_masked || '';
    var keyMasked = '';
    if (key) {
      var tail = key.length > 4 ? key.slice(-4) : key;
      keyMasked = '<span class="provider-key"><span class="key-dot">••••</span>'+esc(tail)+'</span>';
    } else if (p.api_key_configured) {
      keyMasked = '<span class="provider-key"><span class="key-dot">••••</span>已配置</span>';
    }
    var merchant = p.preset || p.kind || (p.local ? '本地' : '自定义');

    // 状态标签：当前使用（蓝紫）/ 回退模型（黄）/ 普通（无标签）
    var statusTag = '';
    if (isActive) statusTag = '<span class="provider-status current">当前使用</span>';
    else if (isFallback) statusTag = '<span class="provider-status fallback">回退模型</span>';

    // 操作按钮（用 data 属性 + 事件委托，避开 WebView 中失效的 stopPropagation）
    var buttons = '<div class="provider-actions">';
    if (isActive) {
      buttons += '<button class="action disabled" data-provider-action="none">使用中</button>';
    } else {
      buttons += '<button class="action" data-provider-action="set-default" data-idx="'+i+'">设为默认</button>';
      if (isFallback) {
        buttons += '<button class="action warn" data-provider-action="unset-fallback" data-idx="'+i+'">取消回退</button>';
      } else {
        buttons += '<button class="action" data-provider-action="set-fallback" data-idx="'+i+'">设为回退</button>';
      }
    }
    buttons += '<button class="action" data-provider-action="edit" data-idx="'+i+'">编辑</button>';
    buttons += '<button class="action danger" data-provider-action="delete" data-idx="'+i+'">删除</button>';
    buttons += '</div>';

    return '<div class="provider-card '+(isActive?'active':'')+'">'+
      '<div class="provider-card-head">'+
        '<span class="provider-merchant">'+esc(merchant)+'</span>'+
        '<span class="provider-name">'+esc(pname)+'</span>'+
        statusTag+
      '</div>'+
      '<div class="provider-model">'+modelText+'</div>'+
      '<div class="provider-meta">temp '+temp+' · max '+maxT+'</div>'+
      keyMasked+
      buttons+
    '</div>';
  }).join('');
  // 一次性事件委托（不依赖 inline stopPropagation，兼容所有浏览器/WebView）
  if (!grid._providerDelegated) {
    grid._providerDelegated = true;
    grid.addEventListener('click', function(ev){
      var btn = ev.target.closest('button[data-provider-action]');
      if (!btn || !grid.contains(btn)) return;
      var idx = parseInt(btn.getAttribute('data-idx'));
      var action = btn.getAttribute('data-provider-action');
      if (isNaN(idx)) return;
      if (action === 'set-default') activateProvider(idx);
      else if (action === 'set-fallback') setFallbackProvider(idx);
      else if (action === 'unset-fallback') unsetFallbackProvider(idx);
      else if (action === 'edit') editProvider(idx);
      else if (action === 'delete') deleteProvider(idx);
    });
  }
}
function activateProvider(i){
  var p=_cfg.providers[i]; if(!p) return;
  _cfg.active_provider = p.name || p.id;
  apiPost('/api/config', _cfg).then(function(){ renderProviders(); _syncModelBtn(); toast('已设为默认：'+(p.name||p.id)); }).catch(function(e){ toast('保存失败：'+e.message); });
}
function setFallbackProvider(i){
  var p=_cfg.providers[i]; if(!p) return;
  var pname = p.name || p.id;
  if(!_cfg.fallback_providers) _cfg.fallback_providers = [];
  if(_cfg.fallback_providers.indexOf(pname)>=0){ toast('已是回退模型'); return; }
  _cfg.fallback_providers.push(pname);
  apiPost('/api/config', _cfg).then(function(){ renderProviders(); toast('已设为回退：'+pname); }).catch(function(e){ toast('保存失败：'+e.message); });
}
function unsetFallbackProvider(i){
  var p=_cfg.providers[i]; if(!p) return;
  var pname = p.name || p.id;
  if(!_cfg.fallback_providers) _cfg.fallback_providers = [];
  if(_cfg.fallback_providers.indexOf(pname)<0){ toast('不是回退模型'); return; }
  _cfg.fallback_providers = _cfg.fallback_providers.filter(function(n){ return n!==pname; });
  apiPost('/api/config', _cfg).then(function(){ renderProviders(); toast('已取消回退：'+pname); }).catch(function(e){ toast('保存失败：'+e.message); });
}
function deleteProvider(i){
  var p=_cfg.providers[i]; if(!p) return;
  var pname = p.name || p.id;
  if(!confirm('确定删除模型服务「'+pname+'」吗？此操作不可恢复。')) return;
  _cfg.providers.splice(i,1);
  // 若删除的是当前默认，自动切到第一个；同时从回退列表移除
  if(_cfg.active_provider===pname){ _cfg.active_provider = (_cfg.providers[0]&&(_cfg.providers[0].name||_cfg.providers[0].id))||''; }
  if(_cfg.fallback_providers){ _cfg.fallback_providers=_cfg.fallback_providers.filter(function(n){ return n!==pname; }); }
  apiPost('/api/config', _cfg).then(function(){ renderProviders(); toast('已删除：'+pname); }).catch(function(e){ toast('保存失败：'+e.message); });
}
function openProviderModal(){ editProvider(null); }
function addProvider(){
  // 添加模型服务：默认「自定义」，不预填任何模型
  openProviderModal();
}
function closeProviderModal(){ var m=document.getElementById('providerModal'); if(m) m.style.display='none'; _providerModelCache=null; _providerModelTestResults={}; _editingProviderHasKey=false; }
var _providerModelCache = null; // 编辑 Provider 时的模型列表 [{id,name,enabled,default}]
var _providerModelTestResults = {}; // 「测试所有模型」结果缓存：{ 列表下标: {ok, latency, error} }
var _editingProviderHasKey = false; // 当前编辑的 Provider 是否已配置 Key（用于跳过空 Key 校验）
function editProvider(idx){
  var m=document.getElementById('providerModal'); if(!m) return;
  // Portal：移到 body 直接子元素，避开 .page.active (display:flex) 的 stacking context
  if (m.parentElement !== document.body) document.body.appendChild(m);
  m.style.display='flex';
  var presetSel=document.getElementById('providerPreset');
  if(presetSel){
    presetSel.innerHTML='<option value="">自定义</option>';
    Object.keys(PV.providerPresets).forEach(function(k){
      var o=document.createElement('option'); o.value=k; o.textContent=PV.providerPresets[k].name; presetSel.appendChild(o);
    });
  }
  var p = (idx!=null && _cfg.providers[idx]) ? _cfg.providers[idx] : null;
  var titleEl=document.getElementById('providerModalTitle'); if(titleEl) titleEl.textContent = p ? '编辑模型提供商' : '添加模型提供商';
  _providerModelTestResults = {};
  document.getElementById('providerId').value = p ? (p.id||idx) : '';
  document.getElementById('providerName').value = p ? (p.name||'') : '';
  document.getElementById('providerBaseUrl').value = p ? (p.base_url||'') : '';
  // API Key 处理：后端出于安全不返回真实 Key，编辑时显示掩码 placeholder + 提示
  var keyInput = document.getElementById('providerKey');
  var keyHint = document.getElementById('providerKeyHint');
  if (p && p.api_key_configured) {
    // 已配置 Key：输入框留空，placeholder 显示掩码，提示用户留空即保留
    keyInput.value = '';
    keyInput.placeholder = p.api_key_masked || '••••已配置';
    if (keyHint) keyHint.style.display = 'block';
    _editingProviderHasKey = true;
  } else if (p && p.api_key && String(p.api_key).indexOf('****') !== 0) {
    // 极少数情况：前端缓存中有明文 key（如刚添加未保存）
    keyInput.value = p.api_key;
    keyInput.placeholder = 'sk-...';
    if (keyHint) keyHint.style.display = 'none';
    _editingProviderHasKey = false;
  } else {
    keyInput.value = '';
    keyInput.placeholder = 'sk-...';
    if (keyHint) keyHint.style.display = 'none';
    _editingProviderHasKey = false;
  }
  document.getElementById('providerNote').value = p ? (p.note||'') : '';
  document.getElementById('providerTemp').value = p && p.temperature!=null ? p.temperature : '0.7';
  document.getElementById('providerMaxTokens').value = p && p.max_tokens!=null ? p.max_tokens : '4096';
  // 初始化模型缓存
  _providerModelCache = [];
  if(p && Array.isArray(p.models) && p.models.length){
    _providerModelCache = p.models.map(_normModel);
  } else if(p && p.model){
    _providerModelCache = [_normModel({ id: p.model, name: p.model, enabled: true, default: true })];
  }
  if(p && p.preset && document.getElementById('providerPreset')) document.getElementById('providerPreset').value = p.preset;
  renderProviderModels();
}
function onProviderPresetChange(){
  var preset=document.getElementById('providerPreset').value;
  var def = preset ? PV.providerPresets[preset] : null;
  if(def && def.base_url) document.getElementById('providerBaseUrl').value = def.base_url;
  if(def && def.models && def.models.length){
    _providerModelCache = def.models.map(function(mo){ return _normModel({ id: mo, name: mo, enabled: true, default: false }); });
  } else {
    // 选择「自定义」或预设无模型列表时，清空模型缓存（不残留上一个预设的模型）
    _providerModelCache = [];
  }
  renderProviderModels();
}
function _normModel(mo){
  mo = mo||{};
  return {
    id: mo.id||mo.name||'',
    name: mo.name||mo.id||'',
    enabled: mo.enabled!==false,
    default: mo.default===true,
    capabilities: (mo.capabilities&&mo.capabilities.length)?mo.capabilities:['text'],
    input_types: (mo.input_types&&mo.input_types.length)?mo.input_types:[],
    context_window: mo.context_window||0,
    max_output_tokens: mo.max_output_tokens||0,
    supports_reasoning: mo.supports_reasoning===true
  };
}
function modelCapabilityBadges(mo){
  var caps=(mo.capabilities||[]).slice();
  if(mo.supports_reasoning===true && caps.indexOf('reasoning')<0) caps.unshift('reasoning');
  var html='';
  caps.forEach(function(c){ var lab=window.PV&&PV.modelCapabilityLabels&&PV.modelCapabilityLabels[c]?PV.modelCapabilityLabels[c]:c; html+='<span class="cap-badge">'+esc(lab)+'</span>'; });
  var cw=mo.context_window||0;
  var ctx = cw>=1000000?'上下文1M':(cw>=256000?'上下文256K':(cw>0?'上下文'+cw:''));
  if(ctx) html+='<span class="cap-badge ctx">'+esc(ctx)+'</span>';
  return html;
}
function renderProviderModels(){
  return renderProviderModelList();
}
function renderProviderModelList(){
  var el=document.getElementById('providerModelList'); if(!el) return;
  var list=_providerModelCache||[];
  var search=((document.getElementById('providerModelSearch')||{}).value||'').trim().toLowerCase();
  if(!list.length){ el.innerHTML='<div class="conn-hint">点击右上角「获取模型」自动拉取全部模型，或用上方「+ 添加」手动新增。</div>'; return; }
  // 批量操作栏
  var enabledCount = list.filter(function(m){ return m.enabled!==false; }).length;
  var batchBar = '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);margin-bottom:6px">' +
    '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text2);cursor:pointer"><input type="checkbox" '+(enabledCount===list.length?'checked':'')+' onchange="toggleAllModels(this.checked)"> 全选</label>' +
    '<span style="font-size:11px;color:var(--text3)">'+enabledCount+'/'+list.length+' 已启用</span>' +
    '</div>';
  // 平铺展示全部模型
  var items = list.map(function(m,i){ return {m:m,i:i}; });
  if(search){
    items = items.filter(function(it){
      var mid=(it.m.id||it.m.name||'').toLowerCase();
      var mname=(it.m.name||'').toLowerCase();
      var prov=(it.m.provider||'').toLowerCase();
      return mid.indexOf(search)>=0||mname.indexOf(search)>=0||prov.indexOf(search)>=0;
    });
  }
  if(!items.length){ el.innerHTML='<div class="conn-hint">没有匹配的模型。</div>'; return; }
  el.innerHTML = batchBar + items.map(function(it){
    var m=it.m; var i=it.i;
    var isDefault=m.default===true;
    var isEnabled=m.enabled!==false;
    var mid=esc(m.id||m.name||'');
    var ctxBadge=m.context_window?'<span class="model-mini-badge">'+(m.context_window>=1000000?(m.context_window/1000000).toFixed(m.context_window%1000000?1:0)+'M':(m.context_window/1000)+'K')+'</span>':'';
    var capsBadges='';
    var caps=m.capabilities||m.input_types||[];
    if(caps.indexOf('image')>=0) capsBadges+='<span class="model-mini-badge" style="color:#8b5cf6;border-color:#8b5cf6" title="支持图像">🖼</span>';
    if(caps.indexOf('audio')>=0) capsBadges+='<span class="model-mini-badge" style="color:#f59e0b;border-color:#f59e0b" title="支持音频">🎧</span>';
    if(caps.indexOf('reasoning')>=0||m.supports_reasoning) capsBadges+='<span class="model-mini-badge" style="color:#10b981;border-color:#10b981" title="支持推理">🧠</span>';
    var tr=(_providerModelTestResults||{})[i];
    var testBadge=tr?(tr.ok?'<span class="model-mini-badge" style="color:var(--success);border-color:var(--success)">✓'+(tr.latency!=null?' '+tr.latency+'ms':'')+'</span>':'<span class="model-mini-badge" title="'+esc(tr.error||'')+'" style="color:#e5534b;border-color:#e5534b">✗</span>'):'';
    return '<div class="model-item '+(isEnabled?'':'disabled')+(isDefault?' applied':'')+'" data-idx="'+i+'">'+
      '<label class="model-check" onclick="event.stopPropagation()"><input type="checkbox" '+(isEnabled?'checked':'')+' onchange="toggleModelEnabled('+i+',this.checked)"></label>'+
      '<span class="model-id" onclick="selectModelInList('+i+', event)">'+mid+'</span>'+
      '<span class="model-badges">'+
        (isDefault?'<span class="model-tick">✓默认</span>':'')+
        testBadge+capsBadges+ctxBadge+
        '<button class="model-cfg-btn" title="独立配置" onclick="openModelEditModal('+i+', event)">⚙</button>'+
        '<button class="model-test-btn" title="测试连通性" onclick="testProviderModel('+i+', event)">⚡</button>'+
      '</span>'+
    '</div>';
  }).join('');
}
function toggleModelEnabled(i, checked){
  var list=_providerModelCache||[]; var m=list[i]; if(!m) return;
  m.enabled = checked;
  renderProviderModelList();
}
function toggleAllModels(checked){
  var list=_providerModelCache||[];
  list.forEach(function(m){ m.enabled = checked; });
  renderProviderModelList();
}
function toggleModelGroup(headEl){
  var body = headEl.nextElementSibling; if(!body) return;
  var collapsed = body.style.display === 'none';
  body.style.display = collapsed ? '' : 'none';
  headEl.classList.toggle('collapsed', !collapsed);
  headEl.querySelector('.chevron').textContent = collapsed ? '▾' : '▸';
}
function selectModelInList(i, ev){
  ev && ev.stopPropagation();
  setDefaultProviderModel(i);
  toast('已应用模型：'+((_providerModelCache[i]||{}).id||''));
}
function openModelEditModal(i, ev){
  if(ev) ev.stopPropagation();
  var list=_providerModelCache||[]; var m=list[i]; if(!m) return;
  var modal=document.getElementById('modelEditModal'); if(!modal) return;
  if (modal.parentElement !== document.body) document.body.appendChild(modal);
  modal.style.display='flex';
  document.getElementById('modelEditIdx').value=i;
  document.getElementById('modelEditId').value=(m.id||'');
  document.getElementById('modelEditName').value=(m.name||m.id||'');
  document.getElementById('modelEditTemp').value=(m.temperature!=null?m.temperature:'');
  document.getElementById('modelEditMaxTokens').value=(m.max_tokens!=null?m.max_tokens:'');
  var inputTypes=(m.input_types&&m.input_types.length)?m.input_types:(m.capabilities||[]).filter(function(c){return c==='text'||c==='image'||c==='audio';});
  ['text','image','audio'].forEach(function(t){
    var el=document.getElementById('modelInput_'+t); if(el) el.classList.toggle('on', inputTypes.indexOf(t)>=0);
  });
  document.getElementById('modelEditCtx').value=(m.context_window||0);
  document.getElementById('modelEditMaxOut').value=(m.max_output_tokens||0);
  var rt=document.getElementById('modelEditReasoning'); if(rt) rt.classList.toggle('on', !!m.supports_reasoning);
}
function closeModelEditModal(){ var m=document.getElementById('modelEditModal'); if(m) m.style.display='none'; }
function toggleModelInput(chip){ if(chip) chip.classList.toggle('on'); }
function setCtxPreset(n, targetId){
  var el=document.getElementById(targetId); if(el){ el.value=n; el.focus(); }
}
function saveModelEdit(){
  var i=parseInt(document.getElementById('modelEditIdx').value);
  var list=_providerModelCache||[]; var m=list[i]; if(!m) return;
  m.id=document.getElementById('modelEditId').value.trim()||m.id;
  m.name=document.getElementById('modelEditName').value.trim()||m.id;
  // Temperature / Max Tokens：留空表示"用 Provider 默认"（删除字段）
  var tEl=document.getElementById('modelEditTemp');
  var mtEl=document.getElementById('modelEditMaxTokens');
  var tVal=tEl?tEl.value.trim():'';
  var mtVal=mtEl?mtEl.value.trim():'';
  if(tVal==='') delete m.temperature; else m.temperature=parseFloat(tVal);
  if(mtVal==='') delete m.max_tokens; else m.max_tokens=parseInt(mtVal);
  var its=['text','image','audio'].filter(function(t){ var el=document.getElementById('modelInput_'+t); return el&&el.classList.contains('on'); });
  m.input_types=its;
  m.context_window=parseInt(document.getElementById('modelEditCtx').value)||0;
  m.max_output_tokens=parseInt(document.getElementById('modelEditMaxOut').value)||0;
  var rt=document.getElementById('modelEditReasoning'); m.supports_reasoning=!!(rt&&rt.classList.contains('on'));
  var caps=its.slice();
  if(m.supports_reasoning && caps.indexOf('reasoning')<0) caps.unshift('reasoning');
  if(m.context_window>=1000000 && caps.indexOf('long_context')<0) caps.push('long_context');
  m.capabilities=caps;
  renderProviderModelList();
  closeModelEditModal();
  toast('已保存模型配置：'+m.name);
}
function toggleProviderModel(i){
  var list=_providerModelCache||[]; var m=list[i]; if(!m) return;
  m.enabled = m.enabled===false ? true : false;
  renderProviderModels();
}
function setDefaultProviderModel(i){
  var list=_providerModelCache||[];
  list.forEach(function(m, idx){ m.default = (idx===i); });
  renderProviderModels();
}
function deleteProviderModel(i){
  var list=_providerModelCache||[]; if(!list[i]) return;
  list.splice(i, 1);
  renderProviderModels();
}
function addProviderModel(){
  // 从「未列出的模型 ID」输入框读取用户输入
  var inp=document.getElementById('providerCustomModelId');
  var v = inp ? (inp.value||'').trim() : '';
  if(!v){ toast('请输入模型 ID'); if(inp) inp.focus(); return; }
  // 查重
  var list=_providerModelCache||[];
  if(list.some(function(m){ return (m.id||m.name)===v; })){ toast('模型已存在：'+v); return; }
  list.push(_normModel({ id:v, name:v, enabled:true, default:list.length===0 }));
  if(inp) inp.value='';
  renderProviderModelList();
}
function updateProviderModelName(i, el){
  var list=_providerModelCache||[]; var m=list[i]; if(!m) return;
  var v = (el.textContent||'').trim();
  m.name = v; m.id = v;
}
/* 模型预配置库：获取模型后自动匹配元数据（上下文窗口、能力、最大输出） */
var MODEL_PRESETS = [
  // DeepSeek
  {pattern:/deepseek-v4/i, ctx:1048576, maxOut:16384, caps:['text','reasoning'], label:'DSV4'},
  {pattern:/deepseek-chat/i, ctx:131072, maxOut:8192, caps:['text'], label:'DeepSeek'},
  {pattern:/deepseek-reasoner/i, ctx:131072, maxOut:16384, caps:['text','reasoning'], label:'R1'},
  // OpenAI
  {pattern:/gpt-4o-mini/i, ctx:128000, maxOut:16384, caps:['text','image','audio'], label:'4o-mini'},
  {pattern:/gpt-4o/i, ctx:128000, maxOut:16384, caps:['text','image','audio'], label:'4o'},
  {pattern:/gpt-4\.1-mini/i, ctx:1047576, maxOut:32768, caps:['text','image'], label:'4.1-mini'},
  {pattern:/gpt-4\.1-nano/i, ctx:1047576, maxOut:32768, caps:['text','image'], label:'4.1-nano'},
  {pattern:/gpt-4\.1/i, ctx:1047576, maxOut:32768, caps:['text','image'], label:'4.1'},
  {pattern:/gpt-4-turbo/i, ctx:128000, maxOut:4096, caps:['text','image'], label:'4T'},
  {pattern:/o3-mini/i, ctx:200000, maxOut:100000, caps:['text','reasoning'], label:'o3-mini'},
  {pattern:/o3/i, ctx:200000, maxOut:100000, caps:['text','image','reasoning'], label:'o3'},
  {pattern:/o1-mini/i, ctx:128000, maxOut:65536, caps:['text','reasoning'], label:'o1-mini'},
  {pattern:/o1/i, ctx:200000, maxOut:100000, caps:['text','image','reasoning'], label:'o1'},
  // Anthropic
  {pattern:/claude-opus-4/i, ctx:200000, maxOut:32768, caps:['text','image','reasoning'], label:'Opus4'},
  {pattern:/claude-sonnet-4/i, ctx:200000, maxOut:16384, caps:['text','image','reasoning'], label:'Sonnet4'},
  {pattern:/claude-3-7-sonnet/i, ctx:200000, maxOut:16384, caps:['text','image','reasoning'], label:'3.7S'},
  {pattern:/claude-3-5-sonnet/i, ctx:200000, maxOut:8192, caps:['text','image'], label:'3.5S'},
  {pattern:/claude-3-5-haiku/i, ctx:200000, maxOut:8192, caps:['text','image'], label:'3.5H'},
  {pattern:/claude-3-opus/i, ctx:200000, maxOut:4096, caps:['text','image'], label:'3O'},
  // Qwen
  {pattern:/qwen-3\.8-max/i, ctx:131072, maxOut:16384, caps:['text','image','reasoning'], label:'Q3.8M'},
  {pattern:/qwen-3\.7-max/i, ctx:131072, maxOut:16384, caps:['text','image','reasoning'], label:'Q3.7M'},
  {pattern:/qwen-3\.7-plus/i, ctx:131072, maxOut:16384, caps:['text','image'], label:'Q3.7P'},
  {pattern:/qwen-3\.6-plus/i, ctx:131072, maxOut:16384, caps:['text','image'], label:'Q3.6P'},
  {pattern:/qwen-3\.6-flash/i, ctx:131072, maxOut:8192, caps:['text','image'], label:'Q3.6F'},
  {pattern:/qwen3-235b/i, ctx:131072, maxOut:16384, caps:['text','reasoning'], label:'Q3-235B'},
  {pattern:/qwen3-32b/i, ctx:131072, maxOut:16384, caps:['text','reasoning'], label:'Q3-32B'},
  {pattern:/qwen-max/i, ctx:131072, maxOut:8192, caps:['text','image'], label:'QMax'},
  {pattern:/qwen-plus/i, ctx:131072, maxOut:8192, caps:['text','image'], label:'QPlus'},
  {pattern:/qwen-turbo/i, ctx:131072, maxOut:8192, caps:['text'], label:'QTurbo'},
  {pattern:/qwen2\.5-72b/i, ctx:131072, maxOut:8192, caps:['text'], label:'Q2.5-72B'},
  // Google
  {pattern:/gemini-2\.5-pro/i, ctx:1048576, maxOut:65536, caps:['text','image','audio','reasoning'], label:'2.5Pro'},
  {pattern:/gemini-2\.5-flash/i, ctx:1048576, maxOut:65536, caps:['text','image','audio','reasoning'], label:'2.5F'},
  {pattern:/gemini-2\.0-flash/i, ctx:1048576, maxOut:8192, caps:['text','image','audio'], label:'2.0F'},
  {pattern:/gemini-1\.5-pro/i, ctx:2097152, maxOut:8192, caps:['text','image','audio'], label:'1.5P'},
  {pattern:/gemini-1\.5-flash/i, ctx:1048576, maxOut:8192, caps:['text','image','audio'], label:'1.5F'},
  // SenseNova
  {pattern:/sensenova.*flash-lite/i, ctx:262144, maxOut:8192, caps:['text'], label:'SN-F Lite'},
  {pattern:/sensenova.*ul-fast/i, ctx:131072, maxOut:8192, caps:['text'], label:'SN-UL'},
  {pattern:/sensenova/i, ctx:262144, maxOut:8192, caps:['text','image'], label:'SN'},
  // GLM
  {pattern:/glm-5/i, ctx:1048576, maxOut:16384, caps:['text','image','reasoning'], label:'GLM5'},
  {pattern:/glm-4-plus/i, ctx:128000, maxOut:8192, caps:['text','image'], label:'GLM4+'},
  {pattern:/glm-4/i, ctx:128000, maxOut:4096, caps:['text','image'], label:'GLM4'},
  // Groq / Llama
  {pattern:/llama-4-maverick/i, ctx:1048576, maxOut:8192, caps:['text','image'], label:'L4M'},
  {pattern:/llama-4-scout/i, ctx:1048576, maxOut:8192, caps:['text','image'], label:'L4S'},
  {pattern:/llama-3\.3-70b/i, ctx:128000, maxOut:8192, caps:['text'], label:'L3.3'},
  // Mistral
  {pattern:/mistral-large/i, ctx:128000, maxOut:8192, caps:['text'], label:'MLarge'},
  {pattern:/mistral-medium/i, ctx:128000, maxOut:8192, caps:['text'], label:'MMed'},
  {pattern:/codestral/i, ctx:256000, maxOut:8192, caps:['text'], label:'Code'},
  // Moonshot
  {pattern:/moonshot-v1-128k/i, ctx:128000, maxOut:8192, caps:['text'], label:'128K'},
  {pattern:/moonshot-v1/i, ctx:32000, maxOut:4096, caps:['text'], label:'KS'},
  // Doubao
  {pattern:/doubao.*pro.*256k/i, ctx:256000, maxOut:16384, caps:['text'], label:'DB-256K'},
  {pattern:/doubao.*pro/i, ctx:128000, maxOut:16384, caps:['text'], label:'DB-Pro'},
  {pattern:/doubao/i, ctx:128000, maxOut:8192, caps:['text'], label:'DB'}
];
function matchModelPreset(modelId){
  if(!modelId) return null;
  for(var i=0;i<MODEL_PRESETS.length;i++){
    if(MODEL_PRESETS[i].pattern.test(modelId)) return MODEL_PRESETS[i];
  }
  return null;
}

function fillModelOptionsFromList(list){
  // 获取模型后写入管理列表：以接口返回为准，仅保留用户对「仍存在」模型的参数编辑
  var incoming = (list||[]).map(function(mo){
    return _normModel(typeof mo==='string' ? { id: mo, name: mo, enabled: true, default: false } : mo);
  });
  // 自动匹配预配置库，填充上下文/能力/最大输出
  var presetApplied = 0;
  incoming.forEach(function(m){
    var preset = matchModelPreset(m.id || m.name);
    if(preset){
      if(!m.context_window) m.context_window = preset.ctx;
      if(!m.max_output_tokens) m.max_output_tokens = preset.maxOut;
      if(!m.input_types || !m.input_types.length) m.input_types = preset.caps.filter(function(c){return c==='text'||c==='image'||c==='audio';});
      if(!m.capabilities || !m.capabilities.length) m.capabilities = preset.caps.slice();
      if(preset.caps.indexOf('reasoning')>=0 && !m.supports_reasoning) m.supports_reasoning = true;
      presetApplied++;
    }
  });
  var prev = _providerModelCache || [];
  var prevById = {};
  prev.forEach(function(m){ var k=m.id||m.name; if(k) prevById[k]=m; });
  var result = incoming.map(function(m){
    var k = m.id||m.name;
    var old = prevById[k];
    if(!old) return m;
    // 保留用户对同一模型的参数编辑
    return Object.assign({}, m, old, { id: m.id||old.id, name: m.name||old.name||m.id });
  });
  _providerModelCache = result;
  _providerModelTestResults = {};
  renderProviderModels();
  toast('已获取 '+result.length+' 个模型' + (presetApplied ? '，自动配置 '+presetApplied+' 个' : ''));
}
// 从 Provider 的 /v1/models 接口拉取模型列表（经后端代理，规避 CORS）
function fetchProviderModels(){
  var provider=buildProviderObj();
  if(!provider.base_url){ toast('请先填写 Base URL'); return; }
  if(!provider.api_key && !_editingProviderHasKey){ toast('请先填写 API Key'); return; }
  toast('正在获取模型列表…');
  apiPost('/api/config/test', { provider: provider }).then(function(r){
    var models=(r&&r.models)?r.models:[];
    if(models.length){ fillModelOptionsFromList(models); }
    else if(r&&r.error){ toast('获取失败：'+r.error); }
    else toast('该端点未返回模型列表，可手动添加');
  }).catch(function(e){ toast('获取失败：'+e.message); });
}
var _autoFetchTimer = null;
function autoFetchModelsDebounced(){
  clearTimeout(_autoFetchTimer);
  _autoFetchTimer = setTimeout(function(){
    var url = (document.getElementById('providerBaseUrl')||{}).value||'';
    var key = (document.getElementById('providerKey')||{}).value||'';
    if(url && key && (_providerModelCache||[]).length === 0){
      fetchProviderModels();
    }
  }, 600);
}
function testProviderModel(i, ev){
  if(ev) ev.stopPropagation();
  var list=_providerModelCache||[]; var m=list[i]; if(!m){ toast('模型不存在'); return; }
  var provider = buildProviderObj();
  if(!provider.base_url){ toast('请先填写 Base URL'); return; }
  var btn = ev && ev.currentTarget ? ev.currentTarget : null;
  if(btn){ btn.classList.add('testing'); btn.disabled = true; }
  toast('正在测试模型：'+(m.id||m.name));
  apiPost('/api/config/test', { provider: provider, model: m.id }).then(function(r){
    if(btn){ btn.classList.remove('testing'); btn.disabled = false; }
    if(r && r.ok){
      var ms = (r.latency_ms!=null)?(' 延迟 '+r.latency_ms+'ms'):'';
      toast('✅ 模型可用：'+(m.id||m.name)+ms);
    } else {
      toast('❌ 模型不可用：'+(m.id||m.name)+'（'+(r&&r.error?r.error:'接口错误')+'）');
    }
  }).catch(function(e){
    if(btn){ btn.classList.remove('testing'); btn.disabled = false; }
    toast('测试失败：'+e.message);
  });
}
function testAllProviderModels(){
  var list=_providerModelCache||[];
  if(!list.length){ toast('请先获取或添加模型'); return; }
  var provider=buildProviderObj();
  if(!provider.base_url){ toast('请先填写 Base URL'); return; }
  toast('正在测试 '+list.length+' 个模型…');
  _providerModelTestResults = {};
  var targets=list.map(function(m,i){ return { id:m.id||m.name, i:i }; });
  Promise.all(targets.map(function(t){
    return apiPost('/api/config/test', { provider: provider, model: t.id }).then(function(r){
      _providerModelTestResults[t.i] = { ok: !!(r&&r.ok), latency: (r&&r.latency_ms!=null)?r.latency_ms:null, error: (r&&r.error)||'' };
    }).catch(function(e){ _providerModelTestResults[t.i] = { ok:false, error:e.message }; });
  })).then(function(){
    var ok=0, fail=0;
    targets.forEach(function(t){ var r=_providerModelTestResults[t.i]; if(r&&r.ok) ok++; else fail++; });
    renderProviderModelList();
    toast('测试完成：✅ '+ok+' 个可用'+(fail?'，❌ '+fail+' 个不可用':''));
  });
}
function toggleKeyVisibility(){
  var inp=document.getElementById('providerKey');
  // 如果输入框为空且处于掩码模式（已配置 Key），从后端获取明文
  if(!inp.value && _editingProviderHasKey){
    var pid=document.getElementById('providerId').value;
    if(!pid){ inp.type = inp.type==='password' ? 'text' : 'password'; return; }
    fetch(apiUrl('/api/provider-key?id='+encodeURIComponent(pid)), { headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d && d.ok && d.api_key){
          inp.value = d.api_key;
          inp.type = 'text';
          var hint=document.getElementById('providerKeyHint');
          if(hint) hint.textContent = '⚠️ 正在显示明文 Key，保存时将使用此值';
        } else {
          toast('无法获取 Key：'+(d&&d.error||'未知错误'));
        }
      })
      .catch(function(){ toast('获取 Key 失败'); });
    return;
  }
  // 已有明文值：切换显示/隐藏
  inp.type = inp.type==='password' ? 'text' : 'password';
}
function validateProvider(evt){
  var provider = buildProviderObj();
  if(!provider.base_url){ toast('请先填写 Base URL 后再验证连接'); return; }
  // 纯连接测试：只验证当前配置（Base URL + Key）能否连通，
  // 绝不刷新/覆盖模型列表配置（获取模型请用「获取模型列表」按钮）。
  var btn=_resolveCheckBtn(evt); if(btn){btn.disabled=true;btn.textContent='验证中…';}
  toast('正在验证连接…');
  apiPost('/api/config/test', { provider: provider, mode: 'connectivity' }).then(function(r){
    if(r && r.ok){
      toast('✅ 连接成功：'+(r.model_count!=null?('端点可用，共 '+r.model_count+' 个模型，'):'')+('延迟 '+(r.latency_ms!=null?r.latency_ms:(r.latency||0))+'ms')+'。当前模型配置未改动');
    } else {
      toast('❌ 连接失败：'+((r&&r.error)||'接口未返回明确结果'));
    }
  }).catch(function(e){ toast('❌ 连接失败：'+e.message); }).finally(function(){ if(btn){btn.disabled=false;btn.textContent='验证连接';} });
}
function buildProviderObj(){
  var id=document.getElementById('providerId').value;
  var preset=document.getElementById('providerPreset').value;
  var name=document.getElementById('providerName').value.trim() || '自定义 Provider';
  var models = (_providerModelCache||[]).map(function(m){ return { id: m.id, name: m.name||m.id, enabled: m.enabled!==false, default: m.default===true, capabilities: m.capabilities||[], input_types: m.input_types||[], context_window: m.context_window||0, max_output_tokens: m.max_output_tokens||0, supports_reasoning: m.supports_reasoning===true }; });
  var defaultModel = '';
  models.forEach(function(m){ if(m.default) defaultModel = m.id; });
  if(!defaultModel){
    var first = models.find(function(m){ return m.enabled!==false; });
    if(first) defaultModel = first.id;
  }
  return {
    id: id || ('custom_'+uid()),
    name: name,
    base_url: document.getElementById('providerBaseUrl').value.trim(),
    api_key: document.getElementById('providerKey').value,
    model: defaultModel,
    models: models,
    note: document.getElementById('providerNote').value,
    temperature: parseFloat(document.getElementById('providerTemp').value)||0.7,
    max_tokens: parseInt(document.getElementById('providerMaxTokens').value)||4096,
    active: true,
    preset: preset || undefined
  };
}
function saveProvider(){
  var name=document.getElementById('providerName').value.trim();
  if(!name){ toast('请填写 Provider 名称'); return; }
  var provider = buildProviderObj();
  var existing = _cfg.providers || [];
  var found = false;
  for(var i=0;i<existing.length;i++){ if(existing[i].id===provider.id || (existing[i].name&&provider.name&&existing[i].name===provider.name)){ existing[i]=provider; found=true; break; } }
  if(!found) existing.push(provider);
  _cfg.providers = existing;
  if(!_cfg.active_provider) _cfg.active_provider = provider.name;
  // 守卫（Issue #2）：至少有一个真实 Provider（非 hermes）才允许保存并自动重启网关
  var realProviders = (existing||[]).filter(function(p){ return (p.id||'').toLowerCase() !== 'hermes'; });
  if(!realProviders.length){
    toast('请先添加并启用至少一个模型');
    return;
  }
  apiPost('/api/config', _cfg).then(function(r){
    if(r && r.error){ toast('保存失败：'+r.error); }
    else {
      toast('已保存 Provider，正在重启网关以应用配置…');
      closeProviderModal(); renderProviders(); _syncModelBtn();
      // 保存后立即重启网关，使新配置（含 API key）对网关生效。
      // 本包网关端口已迁移到 8742、仪表盘到 9219，从根本上规避同机 hermes-studio 对其 8642 网关的 `--replace` 抢占
      // （跨用户进程无法被本包 kill 清除），避免干净重装/并存时被分流到无 provider 的网关。
      apiPost('/api/restart', {}).catch(function(){ /* 非致命，状态轮询会反映 */ });
      // 用户要求（v0.20.65）：保存模型后默认创建一个「默认助手」会话以激活网关
      ensureDefaultSession();
    }
  }).catch(function(e){ toast('保存失败：'+e.message); });
}

// 用户要求（v0.20.65）：保存模型后确保至少存在一个「默认助手」会话，
// 以便网关被激活、聊天不会因缺少会话而失败。已存在会话则跳过。
function ensureDefaultSession(){
  try { if(_sessions && _sessions.length) return; } catch(e){}
  fetch(apiUrl('/api/sessions'), { method:'POST', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(s){
      if(!s || !s.id) return;
      _sessions.unshift(s);
      currentSession = s.id;
      try { setSessionAgent(s.id, currentAgent || 'default'); } catch(e){}
      _openTabs.push(s.id); persistTabs();
      renderSessionTabs(); renderRail(); updateHeader();
    })
    .catch(function(){});
}

/* ============================ 扩展 ============================ */
function extSwitchTab(el, key){
  document.querySelectorAll('#extTabs .ch-filter').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  document.querySelectorAll('.ext-pane').forEach(function(p){ p.classList.remove('active'); });
  var pane=document.getElementById('ext-'+key); if(pane) pane.classList.add('active');
  if(key==='skills') renderSkills('local');
  if(key==='mcp') renderMcpServers();
}
function extSkillSubtab(el, key){
  document.querySelectorAll('#ext-skills .skill-subtabs .ch-filter').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  var bar=document.getElementById('skillMarketBar');
  if(bar) bar.style.display = (key==='market') ? 'block' : 'none';
  if(key==='market'){ renderSkillMarket(); } else { renderSkills(key); }
}
function renderExtensions(){
  renderToolsets(); renderSkills('local'); renderPersonas(); renderExperts(); renderTeam(); renderMemory(); renderWorkflow();
}
function renderToolsets(){
  var el=document.getElementById('toolsetList'); if(!el) return;
  // GET /proxy/dashboard/* 不带 X-Monitor-Token：proxy 会自动注入 X-Hermes-Session-Token，
  // 自带 X-Monitor-Token 会触发 CORS 预检，app-center/trim_app_center 对 OPTIONS 返 401，
  // 导致浏览器控制台出现 401 噪音。这里保持「无自定义头」=简单请求=不预检。
  fetch(apiUrl('/proxy/dashboard/api/tools/toolsets'), { cache:'no-store' })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(list){
      _toolNative = {};
      (list||[]).forEach(function(t){ if(t && t.name) _toolNative[t.name]=t; });
      el.innerHTML = Object.keys(_toolNative).map(function(k){
        var t=_toolNative[k]; var on=!!t.enabled;
        var icon = toolIconFor(k, t);
        return extCardHTML(k, t.label||t.name||k, t.description||'', on, 'toggleToolset(\''+k+'\')', icon);
      }).join('');
    })
    .catch(function(){
      // 仪表盘未启动 / 网络异常：回退到 config.extensions.toolsets（静默）
      var ts = _cfg.extensions.toolsets || {};
      var keys = Object.keys(ts);
      if(!keys.length) keys = PV.toolsets.map(function(t){ return t.id; });
      el.innerHTML = keys.map(function(k){
        var def = PV.toolsets.find(function(t){ return t.id===k; }) || { name:k, icon:'🔧' };
        var on = !!ts[k];
        var icon = def.icon || toolIconFor(k, def);
        return extCardHTML(k, def.name||k, def.desc||'', on, 'toggleToolset(\''+k+'\')', icon);
      }).join('');
    });
}
function extCardHTML(id, name, desc, on, onclick, icon){
  if(icon==null) icon='🔧';
  return '<div class="ext-card" onclick="'+onclick+'">'+
    '<div class="top"><div class="icon">'+icon+'</div><div><div class="name">'+esc(name)+'</div><div class="status '+(on?'on':'off')+'">'+(on?'已启用':'未启用')+'</div></div></div>'+
    '<div class="actions">'+
      '<button class="action" onclick="event.stopPropagation();'+onclick+'">'+(on?'关闭':'启用')+'</button>'+
      '<button class="action secondary" onclick="event.stopPropagation();renderToolConfigModal(\''+esc(id)+'\')">配置</button>'+
    '</div></div>';
}
function toggleToolset(id){
  var newOn;
  if(_toolNative && _toolNative[id]){
    newOn = !_toolNative[id].enabled;
    _toolNative[id].enabled = newOn;
    if(_cfg.extensions) _cfg.extensions.toolsets[id] = newOn;
    fetch(apiUrl('/proxy/dashboard/api/tools/toolsets/'+encodeURIComponent(id)), {
      method:'PUT', headers:{ 'Content-Type':'application/json', 'X-Monitor-Token':monitorToken||'' }, body: JSON.stringify({ enabled:newOn })
    }).then(function(){ renderToolsets(); saveConfig(); }).catch(function(){ renderToolsets(); saveConfig(); });
    return;
  }
  var ts = _cfg.extensions.toolsets;
  ts[id] = !ts[id]; newOn = ts[id];
  renderToolsets(); saveConfig();
}
function renderToolConfigModal(id){
  var modal=document.getElementById('toolConfigModal'); if(!modal) return;
  if (modal.parentElement !== document.body) document.body.appendChild(modal);
  modal.style.display='flex';
  _toolCfgCurrent = id;
  var native = _toolNative && _toolNative[id];
  var titleName = native ? (native.label||native.name) : id;
  var on = !!(native && native.enabled) || !!(_cfg.extensions.toolsets && _cfg.extensions.toolsets[id]);
  var icon = toolIconFor(id, native);
  var title=document.getElementById('toolCfgTitle'); if(title) title.textContent='工具配置：'+titleName;
  // 优先后端 config_fields（非空），否则用 PV.toolConfigFields 兜底
  var fields = (native && native.config_fields && native.config_fields.length) ? native.config_fields : ((window.PV && PV.toolConfigFields && PV.toolConfigFields[id]) || []);
  var body=document.getElementById('toolCfgBody');
  var cfg = (_cfg.extensions.tools_config && _cfg.extensions.tools_config[id]) || {};
  var header = '<div class="tool-cfg-header">'+
    '<div class="icon cfg-icon-lg">'+icon+'</div>'+
    '<div class="tch-meta"><div class="tch-name">'+esc(titleName)+'</div><div class="status '+(on?'on':'off')+'">'+(on?'已启用':'未启用')+'</div></div>'+
    '<label class="toggle '+(on?'on':'')+'" id="toolCfgEnable" onclick="toggleToolCfgEnable()"><span class="toggle-switch"></span></label>'+
    '</div>';
  if(fields && fields.length){
    body.innerHTML = header + fields.map(function(f,i){
      var key=f.key||f.name||('tf_'+i);
      var val=esc(cfg[key]!=null?cfg[key]:(f.default||''));
      return '<div class="skill-config-field"><label>'+esc(f.label||key)+(f.required?' *':'')+'</label><input type="'+(f.type==='password'?'password':'text')+'" data-key="'+esc(key)+'" value="'+val+'" placeholder="'+esc(f.placeholder||'')+'"></div>';
    }).join('');
  } else {
    body.innerHTML = header + '<div class="conn-hint">该工具暂无可配置参数，或参数需通过 Hermes 仪表盘配置。</div>';
  }
}
function toggleToolCfgEnable(){
  var el=document.getElementById('toolCfgEnable'); if(!el) return;
  var on=el.classList.toggle('on');
  var st=el.parentNode.querySelector('.status'); if(st){ st.className='status '+(on?'on':'off'); st.textContent=on?'已启用':'未启用'; }
}
function closeToolConfigModal(){ var m=document.getElementById('toolConfigModal'); if(m) m.style.display='none'; }
function saveToolConfig(){
  var id=_toolCfgCurrent; if(!id) return;
  var values={}; var inputs=document.querySelectorAll('#toolCfgBody input[data-key]');
  for(var i=0;i<inputs.length;i++){ values[inputs[i].getAttribute('data-key')]=inputs[i].value; }
  if(!_cfg.extensions.tools_config) _cfg.extensions.tools_config={};
  _cfg.extensions.tools_config[id]=values;
  // 尽力写仪表盘端点（不存在则静默回退本地）
  fetch(apiUrl('/proxy/dashboard/api/tools/toolsets/'+encodeURIComponent(id)+'/config'), { method:'PUT', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body:JSON.stringify({ config:values }) })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); })
    .catch(function(){});
  saveConfig();
  closeToolConfigModal();
  toast('已保存工具配置：'+id);
}
function skillIcon(s){
  if(!s) return '📦';
  if(s.icon) return s.icon;
  if(s.emoji) return s.emoji;
  var nm = s.name || '';
  if(window.PV && PV.skillIcons && PV.skillIcons[nm]) return PV.skillIcons[nm];
  return '📦';
}
// 工具集图标：后端 icon/emoji → PV.TOOL_ICON_MAP → PV.skillIcons(按 id/name) → 🔧
function toolIconFor(id, t){
  if(t && (t.icon||t.emoji)) return t.icon||t.emoji;
  if(window.PV){
    if(PV.TOOL_ICON_MAP && PV.TOOL_ICON_MAP[id]) return PV.TOOL_ICON_MAP[id];
    if(PV.skillIcons){
      if(PV.skillIcons[id]) return PV.skillIcons[id];
      if(t && t.name && PV.skillIcons[t.name]) return PV.skillIcons[t.name];
    }
  }
  return '🔧';
}
function renderSkills(kind){
  var el=document.getElementById('skillGrid'); if(!el) return;
  if(kind==='native'){
    fetch(apiUrl('/proxy/dashboard/api/skills'), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(list){
        _skillNative = list||[];
        if(!_skillNative.length){ el.innerHTML='<div class="empty-state">未获取到原生技能（请先启动仪表盘）。</div>'; return; }
        el.innerHTML = _skillNative.map(function(s){
          var on=!!s.enabled; var nm=(s.name||'').replace(/'/g,"\\'");
          var desc = esc((s.description||s.desc||'').slice(0,80));
          var tools = Array.isArray(s.tools) ? s.tools.slice(0,4).map(function(t){ return '<code>'+esc(typeof t==='string'?t:(t.name||''))+'</code>'; }).join(' ') : '';
          return '<div class="ext-card" data-skill="'+nm+'">'+
            '<div class="top"><div class="icon">'+skillIcon(s)+'</div><div><div class="name">'+esc(s.name||'')+'</div><div class="status '+(on?'on':'off')+'">'+(on?'已启用':'未启用')+'</div></div></div>'+
            (desc?'<div class="desc">'+desc+'</div>':'')+
            (tools?'<div class="tools">'+tools+'</div>':'')+
            '<div class="actions">'+
              '<button class="action" onclick="event.stopPropagation();toggleNativeSkill(\''+nm+'\')">'+(on?'关闭':'启用')+'</button>'+
              '<button class="action secondary" onclick="event.stopPropagation();openSkillConfig(\''+nm+'\')">配置</button>'+
            '</div></div>';
        }).join('');
      })
      .catch(function(){ el.innerHTML='<div class="empty-state">加载原生技能失败（请先启动仪表盘）。</div>'; });
  } else {
    apiGet('/api/extensions/skills/local').then(function(res){
      if(res && res.ok && res.skills){
        _skillLocal = res.skills;
        if(!_skillLocal.length){ el.innerHTML='<div class="empty-state">尚未发现已安装技能。</div>'; return; }
        el.innerHTML = _skillLocal.map(function(s, i){
          var on=!!(s.status==='enabled'||s.enabled);
          var nm=(s.name||'').replace(/'/g,"\\'");
          var desc = esc((s.description||s.desc||'').slice(0,80));
          return '<div class="ext-card" data-skill="'+nm+'">'+
            '<div class="top"><div class="icon">'+skillIcon(s)+'</div><div><div class="name">'+esc(s.name||'未命名')+'</div><div class="status '+(on?'on':'off')+'">'+(on?'已启用':'未启用')+'</div></div></div>'+
            (desc?'<div class="desc">'+desc+'</div>':'')+
            '<div class="actions">'+
              '<button class="action" onclick="event.stopPropagation();toggleSkill('+i+')">'+(on?'关闭':'启用')+'</button>'+
              '<button class="action secondary" onclick="event.stopPropagation();openSkillConfigLocal('+i+')">配置</button>'+
            '</div></div>';
        }).join('');
      } else {
        el.innerHTML='<div class="empty-state">加载本地技能失败，请部署后重试。</div>';
      }
    });
  }
}
function toggleNativeSkill(name){
  var list=_skillNative||[]; var s=null;
  for(var i=0;i<list.length;i++){ if(list[i].name===name){ s=list[i]; break; } }
  if(!s) return;
  var newOn=!s.enabled;
  fetch(apiUrl('/proxy/dashboard/api/skills/toggle'), { method:'PUT', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ name:name, enabled:newOn }) })
    .then(function(){ s.enabled=newOn; renderSkills('native'); }).catch(function(){ s.enabled=newOn; renderSkills('native'); });
}
function toggleSkill(i){
  var s=_skillLocal[i]; if(!s) return;
  toast('本地技能启停需重启 Hermes 后生效（已记录）');
  // 本地仅做 UI 标记，真实启停由后端安装/重启决定
}
// ── 技能市场（扩展→技能→技能市场：精选目录 + SkillHub 搜索，安装/卸载/配置/获取指引）──
var _skillMarketItems = [];    // 当前市场技能列表（精选目录或搜索结果）
var _skillMarketFilter = 'all';
var _installedSkillNames = []; // 全部已安装技能目录名（供搜索结果对照安装状态）
var _marketCfgCurrent = null;  // 正在配置的市场技能
function renderSkillMarket(){
  var el=document.getElementById('skillGrid'); if(!el) return;
  apiGet('/api/extensions/skills/market-catalog').then(function(res){
    if(res && res.ok && res.items){
      _skillMarketItems = res.items;
      _installedSkillNames = res.installed_names || [];
      renderSkillMarketGrid();
    } else {
      el.innerHTML='<div class="empty-state">加载技能市场失败，请部署后重试。</div>';
    }
  });
}
function renderSkillMarketCatalog(){
  var el=document.getElementById('skillMarketSearch'); if(el) el.value='';
  renderSkillMarket();
}
function setSkillMarketFilter(btn, f){
  _skillMarketFilter = f;
  ['smFilterAll','smFilterInstalled','smFilterOfficial'].forEach(function(id){ var b=document.getElementById(id); if(b) b.classList.remove('active'); });
  if(btn) btn.classList.add('active');
  renderSkillMarketGrid();
}
function renderSkillMarketGrid(){
  var el=document.getElementById('skillGrid'); if(!el) return;
  var rows=[];
  (_skillMarketItems||[]).forEach(function(it, i){
    if(_skillMarketFilter==='installed' && !it.installed) return;
    if(_skillMarketFilter==='official' && !it.official) return;
    rows.push({ it:it, i:i });
  });
  if(!rows.length){ el.innerHTML='<div class="empty-state">没有匹配的技能。</div>'; return; }
  el.innerHTML = rows.map(function(r){ return renderSkillMarketCard(r.it, r.i); }).join('');
}
function renderSkillMarketCard(it, i){
  var installed=!!it.installed;
  var icon=it.icon||'🧩';
  var official=it.official?'<span class="conn-badge" style="background:rgba(139,92,246,.15);color:#a78bfa;border-color:rgba(139,92,246,.4)">官方</span>':'';
  var desc=esc((it.desc||it.description||'').slice(0,80));
  var meta='';
  if(it._search){
    var bits=[];
    if(it.downloads) bits.push(it.downloads+' 次安装');
    if(it.stars) bits.push(it.stars+' 星');
    if(bits.length) meta='<div class="conn-hint" style="margin:0 0 10px">'+esc(bits.join(' · '))+'</div>';
  }
  var actions='';
  if(installed){
    actions+='<button class="action danger" onclick="event.stopPropagation();uninstallMarketSkill('+i+')">卸载</button>';
    actions+='<button class="action secondary" onclick="event.stopPropagation();configMarketSkill('+i+')">配置</button>';
  } else {
    actions+='<button class="action primary" onclick="event.stopPropagation();installMarketSkill('+i+')">安装</button>';
  }
  actions+='<button class="action secondary" onclick="event.stopPropagation();openMarketGuide('+i+')">获取指引</button>';
  return '<div class="ext-card">'+
    '<div class="top"><div class="icon">'+icon+'</div><div><div class="name">'+esc(it.name||'未命名')+official+'</div><div class="status '+(installed?'on':'off')+'">'+(installed?'已安装':'未安装')+'</div></div></div>'+
    (desc?'<div class="desc">'+desc+'</div>':'')+
    meta+
    '<div class="actions">'+actions+'</div></div>';
}
function installMarketSkill(i){
  var it=_skillMarketItems[i]; if(!it) return;
  var payload={ slug: it.slug, namespace: it.namespace, name: it.id || it.slug };
  if(it.mcp && it.mcp.url){ payload.mcp={ name: it.mcp.name, url: it.mcp.url, headers:{} }; }
  toast('正在安装 '+it.name+'…');
  apiPost('/api/extensions/skills/install-package', payload).then(function(res){
    if(res && res.ok){
      toast('✅ '+it.name+' 安装成功'+((it.mcp&&it.mcp.fields)?'，请点击「配置」输入凭证':''));
      renderSkillMarket();
    } else {
      toast('❌ 安装失败：'+((res&&res.error)||'未知错误'));
    }
  });
}
function uninstallMarketSkill(i){
  var it=_skillMarketItems[i]; if(!it) return;
  var name=it.id || it.slug;
  if(!confirm('确定卸载技能「'+(it.name||name)+'」？\n将删除其本地文件与注册信息（含 MCP 服务器）。')) return;
  toast('正在卸载 '+it.name+'…');
  var payload={ name: name };
  if(it.mcp && it.mcp.name) payload.mcp_name=it.mcp.name;
  apiPost('/api/extensions/skills/uninstall', payload).then(function(res){
    if(res && res.ok){ toast('🗑️ '+it.name+' 已卸载'); renderSkillMarket(); }
    else { toast('❌ 卸载失败：'+((res&&res.error)||'未知错误')); }
  });
}
function configMarketSkill(i){
  var it=_skillMarketItems[i]; if(!it) return;
  _marketCfgCurrent=it;
  var title=document.getElementById('marketCfgTitle');
  var body=document.getElementById('marketCfgBody');
  if(title) title.textContent=(it.name||'技能')+' 配置';
  if(!body) return;
  var html='';
  if(it.mcp && it.mcp.fields && it.mcp.fields.length){
    if(it.desc||it.description) html+='<div class="conn-desc">'+esc(it.desc||it.description)+'</div>';
    if(it.cred_hint) html+='<div class="conn-hint">💡 '+esc(it.cred_hint)+'</div>';
    html+='<div class="conn-section-title">凭证</div><div class="conn-fields">';
    it.mcp.fields.forEach(function(f){
      html+='<div class="field"><label>'+esc(f.label||f.key)+'</label><input type="password" id="mktCfg_'+esc(f.key)+'" value="" placeholder="留空则保留原值"></div>';
    });
    html+='</div>';
    html+='<div class="conn-hint">保存后将注册为 MCP 服务器，由对话中的智能体调用（自动重启网关生效）。</div>';
  } else {
    if(it.desc||it.description) html+='<div class="conn-desc">'+esc(it.desc||it.description)+'</div>';
    html+='<div class="conn-hint">💡 凭证提示：'+esc(it.cred_hint||'该技能无需额外凭证')+'</div>';
    html+='<div class="conn-hint">该技能的凭证由其内置脚本管理，请按「获取指引」完成授权。</div>';
    var gurl=it.guide_url||it.webUrl||'';
    if(gurl) html+='<a class="conn-doc" href="'+esc(gurl)+'" target="_blank">📄 查看获取指引 →</a>';
  }
  body.innerHTML=html;
  var m=document.getElementById('marketCfgModal');
  if(m && m.parentElement!==document.body) document.body.appendChild(m);
  if(m) m.style.display='flex';
}
function closeMarketConfig(){ var m=document.getElementById('marketCfgModal'); if(m) m.style.display='none'; _marketCfgCurrent=null; }
function saveMarketConfig(){
  var it=_marketCfgCurrent; if(!it){ closeMarketConfig(); return; }
  if(!(it.mcp && it.mcp.fields && it.mcp.fields.length)){
    toast('该技能通过内置脚本配置，请参考获取指引');
    closeMarketConfig(); return;
  }
  var headers={};
  it.mcp.fields.forEach(function(f){
    var el=document.getElementById('mktCfg_'+f.key);
    var v=el?el.value.trim():'';
    if(v) headers[f.header]=(f.prefix||'')+v;
  });
  apiPost('/api/extensions/skills/config-mcp', { name: it.mcp.name, url: it.mcp.url, headers: headers }).then(function(res){
    if(res && res.ok){ toast('✅ 凭证已保存，网关重启后生效'); closeMarketConfig(); }
    else { toast('❌ 保存失败：'+((res&&res.error)||'未知错误')); }
  });
}
function openMarketGuide(i){
  var it=_skillMarketItems[i]; if(!it) return;
  var url=it.guide_url||it.webUrl||('https://www.skillhub.cn/skills/'+(it.slug||''));
  window.open(url, '_blank');
}
function searchSkillMarket(){
  var el=document.getElementById('skillMarketSearch');
  var kw=el?el.value.trim():'';
  if(!kw){ renderSkillMarket(); return; }
  var grid=document.getElementById('skillGrid');
  if(grid) grid.innerHTML='<div class="empty-state">正在搜索 SkillHub…</div>';
  apiGet('/api/extensions/skills/search?keyword='+encodeURIComponent(kw)).then(function(res){
    if(res && res.ok && res.items){
      _skillMarketItems=res.items.map(function(it){
        return {
          id: it.slug, name: it.name, icon: '', desc: it.description,
          slug: it.slug, namespace: it.namespace, guide_url: it.webUrl,
          cred_hint: '', official: false,
          installed: _installedSkillNames.indexOf(it.slug)>=0,
          _search: true, downloads: it.downloads, stars: it.stars
        };
      });
      renderSkillMarketGrid();
    } else {
      if(grid) grid.innerHTML='<div class="empty-state">搜索失败：'+esc((res&&res.error)||'未知错误')+'</div>';
    }
  });
}
var _skillCfgCurrent = null; // { kind:'native'|'local', index, name }
var _toolCfgCurrent = null;  // 当前正在配置的工具 id（替代放在 body 内会被 innerHTML 覆盖的 hidden input）
function openSkillConfig(name){
  var list=_skillNative||[]; var s=null;
  for(var i=0;i<list.length;i++){ if(list[i].name===name){ s=list[i]; _skillCfgCurrent={kind:'native',index:i,name:name}; break; } }
  if(!s){ toast('未找到该技能'); return; }
  renderSkillConfigModal(s);
}
function openSkillConfigLocal(i){
  var s=_skillLocal[i]; if(!s) return;
  _skillCfgCurrent={kind:'local',index:i,name:s.name};
  renderSkillConfigModal(s);
}
function closeSkillConfigModal(){ document.getElementById('skillConfigModal').style.display='none'; _skillCfgCurrent=null; }
function renderSkillConfigModal(s){
  var title = document.getElementById('skillCfgTitle');
  var body = document.getElementById('skillCfgBody');
  var setupBtn = document.getElementById('skillCfgSetupBtn');
  if(title) title.textContent = (s.name||'未命名') + ' 配置';
  if(!body) return;
  if(!_skillCfgCurrent) _skillCfgCurrent = { kind:'native', name:s.name };
  _skillCfgCurrent.name = s.name;
  var saved = (_cfg.extensions.skills_config && _cfg.extensions.skills_config[s.name]) || {};
  var icon = skillIcon(s);
  var on = !!(s.enabled || s.status==='enabled');
  _skillCfgCurrent.enabled = on;
  var html = '<div class="setting-row" style="margin-bottom:14px"><div style="display:flex;align-items:center;gap:12px"><div class="cfg-icon-lg">'+icon+'</div><div><div style="font-weight:600">'+esc(s.name||'')+'</div><div class="status '+(on?'on':'off')+'">'+(on?'已启用':'未启用')+'</div></div></div><div class="toggle '+(on?'on':'')+'" onclick="toggleSkillCfgEnabled()"></div></div>';
  var cliOn = !!saved.cli_disabled;
  html += '<div class="setting-row" style="margin-bottom:14px"><div><div class="label">Disabled for CLI</div><div class="desc">在 CLI 中禁用此技能</div></div><div class="toggle '+(cliOn?'on':'')+'" id="skillCfgCliToggle" onclick="toggleSkillCfgCli()"></div></div>';
  if(s.description||s.desc) html += '<p class="conn-desc">'+esc(s.description||s.desc)+'</p>';
  // 工具列表
  if(Array.isArray(s.tools) && s.tools.length){
    html += '<div class="conn-section-title">工具</div><div class="conn-tools">'+s.tools.map(function(t){ var n=typeof t==='string'?t:(t.name||''); return '<code>'+esc(n)+'</code>'; }).join(' ')+'</div>';
  }
  // 配置字段（优先用后端给出的 config/schema）
  var cfgFields = s.config_fields || s.configFields || (s.config && s.config.fields) || (s.schema && s.schema.fields);
  var providers = s.providers || s.config_options || (s.config && s.config.providers);
  var savedConfig = saved.config || {};
  if(providers && providers.length){
    html += '<div class="conn-section-title">选择提供商</div>';
    providers.forEach(function(p, idx){
      var sel = (_skillCfgCurrent.providerIdx===idx);
      var pid = 'skillProv_'+idx;
      html += '<div class="skill-config-provider'+(sel?' selected':'')+'">'+
        '<div class="prov-head"><div><span class="prov-name">'+esc(p.name||p.label||('方案 '+(idx+1)))+'</span> '+(p.badge?'<span class="prov-badge">'+esc(p.badge)+'</span>':'')+'</div><button class="action" style="width:auto;padding:5px 12px" onclick="selectSkillProvider('+idx+')">'+(sel?'已选':'Select')+'</button></div>'+
        (p.description||p.desc?'<div class="prov-desc">'+esc(p.description||p.desc)+'</div>':'')+
        '<div id="'+pid+'"></div></div>';
    });
  } else if(cfgFields && cfgFields.length){
    html += '<div class="conn-section-title">配置参数</div>'+renderSkillConfigFields(cfgFields, savedConfig);
  } else {
    html += '<div class="conn-hint">该技能未暴露可配置参数，或参数需通过 Hermes 仪表盘/CLI 配置。</div>';
  }
  body.innerHTML = html;
  if(setupBtn) setupBtn.style.display = (s.needs_setup || s.setup_command) ? 'inline-block' : 'none';
  var scm = document.getElementById('skillConfigModal');
  if (scm && scm.parentElement !== document.body) document.body.appendChild(scm);
  document.getElementById('skillConfigModal').style.display='flex';
}
function renderSkillConfigFields(fields, values){
  return fields.map(function(f, i){
    var key = f.key || f.name || ('field_'+i);
    var val = esc(values[key] || f.default || '');
    var ph = esc(f.placeholder || f.label || '');
    return '<div class="skill-config-field"><label>'+esc(f.label||key)+(f.required?' *':'')+'</label><input type="'+(f.type==='password'?'password':'text')+'" data-key="'+esc(key)+'" value="'+val+'" placeholder="'+ph+'"></div>';
  }).join('');
}
function toggleSkillCfgEnabled(){
  if(!_skillCfgCurrent) return;
  if(_skillCfgCurrent.kind==='local'){
    _skillCfgCurrent.enabled = !_skillCfgCurrent.enabled;
    var t=document.querySelector('#skillConfigModal .toggle');
    if(t) t.classList.toggle('on', _skillCfgCurrent.enabled);
    return;
  }
  if(_skillCfgCurrent.kind==='native'){ toggleNativeSkill(_skillCfgCurrent.name); renderSkillConfigModal(_skillNative[_skillCfgCurrent.index]); }
}
function toggleSkillCfgCli(){
  var t=document.getElementById('skillCfgCliToggle'); if(t) t.classList.toggle('on');
}
function selectSkillProvider(idx){ if(!_skillCfgCurrent) return; _skillCfgCurrent.providerIdx = idx; renderSkillConfigModal(_skillCfgCurrent.kind==='native'?_skillNative[_skillCfgCurrent.index]:_skillLocal[_skillCfgCurrent.index]); }
function saveSkillConfig(){
  if(!_skillCfgCurrent){ closeSkillConfigModal(); return; }
  var values={}; var inputs=document.querySelectorAll('#skillCfgBody input[data-key]');
  for(var i=0;i<inputs.length;i++){ values[inputs[i].getAttribute('data-key')] = inputs[i].value; }
  var cliDisabled = document.getElementById('skillCfgCliToggle') && document.getElementById('skillCfgCliToggle').classList.contains('on');
  var enabled = (_skillCfgCurrent.kind!=='local') ? (_skillNative && _skillNative[_skillCfgCurrent.index] ? !!_skillNative[_skillCfgCurrent.index].enabled : true) : !!_skillCfgCurrent.enabled;
  var payload = { name:_skillCfgCurrent.name, config:values, cli_disabled:cliDisabled, enabled:enabled };
  if(_skillCfgCurrent.providerIdx!=null) payload.provider_idx=_skillCfgCurrent.providerIdx;
  // 本地落点（无论仪表盘是否成功都先记录，保证可持久化，决策 4）
  if(!_cfg.extensions.skills_config) _cfg.extensions.skills_config={};
  _cfg.extensions.skills_config[_skillCfgCurrent.name] = { config:values, cli_disabled:cliDisabled, enabled:enabled, provider_idx:_skillCfgCurrent.providerIdx };
  fetch(apiUrl('/proxy/dashboard/api/skills/config'), { method:'PUT', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body:JSON.stringify(payload) })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(){ toast('技能配置已保存（仪表盘）'); closeSkillConfigModal(); renderSkills(_skillCfgCurrent.kind==='native'?'native':'local'); })
    .catch(function(){
      saveConfig();
      toast('已保存到本地配置（若仪表盘支持在线配置，请确保 dashboard 已启动）');
      closeSkillConfigModal();
    });
}
function runSkillSetup(){
  if(!_skillCfgCurrent) return;
  var s = _skillCfgCurrent.kind==='native' ? _skillNative[_skillCfgCurrent.index] : _skillLocal[_skillCfgCurrent.index];
  if(!s || !s.setup_command){ toast('该技能无需安装'); return; }
  toast('正在执行安装：'+s.setup_command);
  fetch(apiUrl('/proxy/dashboard/api/skills/setup'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body:JSON.stringify({name:s.name, command:s.setup_command}) })
    .then(function(r){ return r.json(); }).then(function(d){ toast(d.message||'安装完成'); }).catch(function(){ toast('安装请求失败（请检查 dashboard 是否启动）'); });
}
function renderMemory(){
  setToggle('memToggle', !!(_cfg.extensions.memory && _cfg.extensions.memory.enabled));
  var r=document.getElementById('memLimit'); if(r && _cfg.extensions.memory) r.value=_cfg.extensions.memory.char_limit;
  var v=document.getElementById('memLimitVal'); if(v && _cfg.extensions.memory) v.textContent=_cfg.extensions.memory.char_limit;
}
function toggleMemory(){
  if(!_cfg.extensions.memory) _cfg.extensions.memory={enabled:true,char_limit:2200};
  _cfg.extensions.memory.enabled = !_cfg.extensions.memory.enabled;
  renderMemory(); saveConfig();
}
function updateMemLimit(val){
  if(!_cfg.extensions.memory) _cfg.extensions.memory={enabled:true,char_limit:2200};
  _cfg.extensions.memory.char_limit = parseInt(val)||2200;
  var v=document.getElementById('memLimitVal'); if(v) v.textContent=val;
  saveConfig();
}
function renderWorkflow(){
  var wf = _cfg.extensions.workflow;
  if(!wf || typeof wf!=='object') wf=_cfg.extensions.workflow={enabled:false,active:false,key:'',name:'',concurrency:2,category:'',inputs:[],steps:[]};
  var on = !!(wf.enabled || (wf.steps && wf.steps.length));
  setToggle('wfToggle', on);
  var n=document.getElementById('wfNameInline'); if(n) n.value=wf.name||'';
  var c=document.getElementById('wfConcInline'); if(c) c.value=(wf.concurrency||2);
  renderWfSteps('Inline','wfStepsInline');
  renderWorkflowPresets();
}
function renderWfSteps(token, cid){
  var el=document.getElementById(cid); if(!el) return;
  var wf=_cfg.extensions.workflow||{steps:[]};
  var steps=wf.steps||[];
  if(!steps.length){ el.innerHTML='<div class="conn-hint">暂无步骤，点击「+ 添加步骤」开始编排。</div>'; return; }
  el.innerHTML = steps.map(function(s,i){
    var depChecks = steps.map(function(o,j){
      if(j===i) return '';
      var checked=(s.depends_on||[]).indexOf(o.id)>=0 ? 'checked':'';
      return '<label class="wf-dep"><input type="checkbox" id="wfStep_'+token+'_'+i+'_dep_'+j+'" '+checked+'> '+esc(o.id||('步骤'+j))+'</label>';
    }).join('');
    return '<div class="wf-step-card">'+
      '<div class="wf-step-head"><span>步骤 '+(i+1)+'</span><button class="action sm danger" onclick="delWfStep('+i+',\''+token+'\')">删除</button></div>'+
      '<div class="field"><label>步骤 ID</label><input id="wfStep_'+token+'_'+i+'_id" value="'+esc(s.id||'')+'"></div>'+
      '<div class="field"><label>专家（agency id）</label><input id="wfStep_'+token+'_'+i+'_expert" value="'+esc(s.expert||s.role||'')+'" placeholder="agency_xxx"></div>'+
      '<div class="field"><label>任务（支持 {{变量}}）</label><textarea id="wfStep_'+token+'_'+i+'_task" rows="2">'+esc(s.task||'')+'</textarea></div>'+
      '<div class="field"><label>输出变量名</label><input id="wfStep_'+token+'_'+i+'_output" value="'+esc(s.output||'')+'"></div>'+
      (depChecks?'<div class="field"><label>依赖步骤</label><div class="wf-dep-list">'+depChecks+'</div></div>':'')+
      '<button class="action" style="margin-top:6px" onclick="saveWfStep('+i+',\''+token+'\')">保存步骤</button>'+
      '</div>';
  }).join('');
}
function refreshWfEditors(){
  var mOpen = document.getElementById('workflowEditorModal') && document.getElementById('workflowEditorModal').style.display!=='none';
  renderWfSteps('Inline','wfStepsInline');
  if(mOpen) renderWfSteps('Modal','wfStepsModal');
}
function openWorkflowEditor(){
  var wf=_cfg.extensions.workflow; if(!wf||typeof wf!=='object') wf=_cfg.extensions.workflow={enabled:false,active:false,key:'',name:'',concurrency:2,inputs:[],steps:[]};
  var n=document.getElementById('wfNameModal'); if(n) n.value=wf.name||'';
  var c=document.getElementById('wfConcModal'); if(c) c.value=(wf.concurrency||2);
  renderWfSteps('Modal','wfStepsModal');
  var wm=document.getElementById('workflowEditorModal');
  if(wm && wm.parentElement !== document.body) document.body.appendChild(wm);
  document.getElementById('workflowEditorModal').style.display='flex';
}
function closeWorkflowEditor(){ var m=document.getElementById('workflowEditorModal'); if(m) m.style.display='none'; }
function syncWfMetaFrom(token){
  var wf=_cfg.extensions.workflow; if(!wf||typeof wf!=='object') return;
  var n=document.getElementById('wfName'+token); if(n) wf.name=n.value;
  var c=document.getElementById('wfConc'+token); if(c) wf.concurrency=parseInt(c.value)||2;
}
function addWfStep(token){
  if(!_cfg.extensions.workflow || typeof _cfg.extensions.workflow!=='object') _cfg.extensions.workflow={enabled:false,active:false,key:'',name:'',concurrency:2,inputs:[],steps:[]};
  var wf=_cfg.extensions.workflow;
  if(!wf.steps) wf.steps=[];
  wf.steps.push(JSON.parse(JSON.stringify(PV.wfStepDefaults)));
  saveConfig(); refreshWfEditors();
}
function saveWfStep(i, token){
  var wf=_cfg.extensions.workflow; if(!wf) return;
  var s=wf.steps[i]; if(!s) return;
  s.id=document.getElementById('wfStep_'+token+'_'+i+'_id').value.trim()||('step_'+i);
  s.expert=document.getElementById('wfStep_'+token+'_'+i+'_expert').value.trim();
  s.task=document.getElementById('wfStep_'+token+'_'+i+'_task').value;
  s.output=document.getElementById('wfStep_'+token+'_'+i+'_output').value.trim();
  var deps=[];
  wf.steps.forEach(function(o,j){ if(j!==i){ var cb=document.getElementById('wfStep_'+token+'_'+i+'_dep_'+j); if(cb&&cb.checked) deps.push(o.id); } });
  s.depends_on=deps;
  saveConfig(); toast('已保存步骤：'+s.id); refreshWfEditors();
}
function delWfStep(i, token){
  var wf=_cfg.extensions.workflow; if(!wf) return;
  wf.steps.splice(i,1);
  saveConfig(); refreshWfEditors();
}
function setCurrentWorkflow(){
  var wf=_cfg.extensions.workflow; if(!wf||typeof wf!=='object') wf=_cfg.extensions.workflow={enabled:false,active:false,key:'',name:'',concurrency:2,inputs:[],steps:[]};
  syncWfMetaFrom('Inline'); syncWfMetaFrom('Modal');
  wf.enabled=true; wf.active=true;
  if(!_cfg.extensions.toolsets) _cfg.extensions.toolsets={};
  _cfg.extensions.toolsets.delegation=true;
  saveConfig(); closeWorkflowEditor(); renderWorkflow(); toast('已设为当前工作流');
}
function clearWorkflow(){
  _cfg.extensions.workflow = { enabled:false, active:false, key:'', name:'', concurrency:2, category:'', inputs:[], steps:[] };
  saveConfig(); renderWorkflow(); renderWorkflowBar(); toast('已清除工作流');
}
var _wfCat='';
function renderWorkflowPresets(){
  var grid=document.getElementById('wfGrid'); if(!grid) return;
  var presets = window.AO_WORKFLOW_PRESETS || [];
  var catLabels={
    '':'全部','data':'数据','department-collab':'部门协作','design':'设计','dev':'开发',
    'English':'英文','hr':'人力资源','legal':'法务','marketing':'营销','ops':'运维',
    'strategy':'战略','一人公司':'一人公司',
    'superpowers':'Superpowers 方法论','中国特色':'中国特色场景'
  };
  // 常见英文工作流名 → 中文
  var nameLabels={
    'Business Plan':'商业计划书','Code Architecture Review':'代码架构审查',
    'Competitor Analysis Report':'竞品分析报告','Customer Discovery':'客户调研',
    'Customer Persona':'用户画像','Daily Standup':'每日站会','Data Audit':'数据审计',
    'Data Migration':'数据迁移','Decision Memo':'决策备忘','Design Review':'设计评审',
    'Documentation Sprint':'文档冲刺','Feature Spec':'功能规格说明书',
    'Go-to-Market Plan':'上市推广方案','Hiring Pipeline':'招聘流程',
    'Incident Response':'事故应急响应','Launch Checklist':'上线检查清单',
    'Marketing Campaign':'营销活动','Onboarding Plan':'入职培训计划',
    'OKR Setting':'OKR 制定','Performance Review':'绩效评估',
    'Postmortem':'事后复盘','Pricing Experiment':'定价实验',
    'Quarterly Planning':'季度规划','Release Notes':'发布说明',
    'Roadmap':'路线图','Sprint Planning':'Sprint 计划',
    'Stakeholder Update':'利益相关方同步','Strategy Memo':'战略备忘',
    'User Interview Synthesis':'用户访谈汇总','一人公司:全灵大会':'一人公司:全灵大会'
  };
  var cats=[{id:'',label:catLabels['']||'全部'}];
  presets.forEach(function(p){ if(p.category && !cats.some(function(c){return c.id===p.category;})) cats.push({id:p.category,label:catLabels[p.category]||p.category}); });
  var catSel=document.getElementById('wfCats');
  if(catSel && catSel.tagName==='SELECT'){
    catSel.innerHTML = cats.map(function(c){ return '<option value="'+esc(c.id)+'"'+(c.id===_wfCat?' selected':'')+'>'+esc(c.label)+'</option>'; }).join('');
  }
  var appliedKey = String((_cfg.extensions.workflow && _cfg.extensions.workflow.key) || '').replace(/\\/g,'/');
  grid.innerHTML = presets.filter(function(p){ return !_wfCat || p.category===_wfCat; }).map(function(p){
    var applied = (String(p.key).replace(/\\/g,'/')===appliedKey);
    var catLabel = catLabels[p.category]||p.category||'通用';
    var nameZh = nameLabels[p.name] || p.name;
    return '<div class="ext-card'+(applied?' active':'')+'">'+
      '<div class="top"><div class="icon">🎛️</div><div><div class="name">'+esc(nameZh)+'</div><div class="status">'+esc(catLabel)+(applied?' · 已应用':'')+'</div></div></div>'+
      '<div class="conn-desc">'+esc(p.description||'')+'</div>'+
      '<button class="action" data-wfkey="'+esc(p.key)+'" onclick="applyWorkflow(this.getAttribute(\'data-wfkey\'))">'+(applied?'重新应用':'应用')+'</button></div>';
  }).join('') || '<div class="empty-state">暂无工作流模板。</div>';
}
function setWfCat(cat){ _wfCat=cat; renderWorkflowPresets(); }
function applyWorkflow(key){
  var nk=String(key||'').replace(/\\/g,'/');
  var p=(window.AO_WORKFLOW_PRESETS||[]).find(function(x){ return String(x.key).replace(/\\/g,'/')===nk; });
  if(!p){ toast('未找到工作流模板','error'); return; }
  if(!p.steps || !p.steps.length){ toast('该工作流模板无步骤，不可用','error'); return; }
  // 将不存在的专家 ID 映射为 auto（自动分配）
  var validSteps = p.steps.map(function(s){
    var step = Object.assign({}, s);
    if(step.expert && step.expert !== 'auto'){
      var exists = (_profiles||[]).some(function(pr){ return pr.id===step.expert; });
      if(!exists) step.expert = 'auto';
    }
    return step;
  });
  _cfg.extensions.workflow = {
    key:p.key, name:p.name, description:p.description,
    enabled:true, active:true, concurrency:(p.concurrency||2), category:(p.category||''),
    inputs:(p.inputs||[]), steps:validSteps
  };
  if(!_cfg.extensions.toolsets) _cfg.extensions.toolsets={};
  _cfg.extensions.toolsets.delegation=true;
  saveConfig(); renderWorkflow(); renderWorkflowBar(); toast('✅ 已应用工作流：'+p.name+'（发送消息即触发）');
}
function toggleWorkflow(){
  var wf=_cfg.extensions.workflow;
  if(!wf || typeof wf!=='object') wf=_cfg.extensions.workflow={ name:'我的工作流', concurrency:2, steps:[] };
  wf.enabled = !wf.enabled;
  _cfg.extensions.workflow = wf;
  renderWorkflow(); saveConfig();
}
/* persona / profiles 系统（与 Hermes 官方 profiles 完全对齐） */
/* 参考: hermesagent.org.cn/docs/user-guide/profiles */
/* 每个 profile = 完全隔离的 Hermes 环境（独立 config.yaml、.env、SOUL.md、记忆、会话、技能、网关） */
var _profiles = [];  // 从后端 /api/profiles 拉取
var _profilesLoaded = false;
function allPersonas(){
  // 兼容层：将 profiles 转换为旧版 persona 格式（供 chat 系统使用）
  var out={};
  _profiles.forEach(function(p){ out[p.id] = { emoji:p.emoji, label:p.name, prompt:p.prompt }; });
  if(!_profiles.length){
    out['default']={emoji:'🤖',label:'默认助手',prompt:'你是用户的默认主力助手。'};
  }
  return out;
}
function fetchProfiles(cb){
  apiGet('/api/profiles').then(function(res){
    if(res && res.ok && res.profiles){ _profiles = res.profiles; _profilesLoaded = true; }
    if(cb) cb();
  }).catch(function(){ if(cb) cb(); });
}
// ── 预设智能体模板（内置，一键套用激活）────────────────────────────────────
var PRESET_AGENT_TEMPLATES = [
  { id:'fnos_operator', emoji:'🖥️', name:'飞牛操作员', desc:'NAS 运维专家：TRIM CLI、应用中心、存储/网络、容器、日志与备份恢复', prompt:'你是一位资深的飞牛 fnOS NAS 运维专家。精通 TRIM CLI（应用管理/日志/存储/网络/系统）、应用中心全流程（安装、升级、卸载、热补丁、回调脚本）、存储卷与共享文件夹、Docker 容器、系统日志排查、备份与恢复。回答时优先给出可直接执行的命令与步骤，注重数据安全并主动提示操作风险，遇到不确定的配置先说明风险再给方案。' },
  { id:'coder', emoji:'💻', name:'程序员', desc:'全栈工程师：可运行代码优先，注重安全与可维护性', prompt:'你是一位资深全栈工程师。优先给出可直接运行的代码与命令，注重安全性、可维护性与生产实践；遇到模糊需求先给出最小可行方案再迭代。' },
  { id:'researcher', emoji:'🔬', name:'研究员', desc:'严谨调研：基于证据、引用来源，区分事实与推测', prompt:'你是一位严谨的研究员。回答须基于证据、引用来源，并明确区分事实、推测与不确定信息；避免臆断。' },
  { id:'writer', emoji:'✍️', name:'写作助手', desc:'专业写作：结构化中文表达，按场景调整语气篇幅', prompt:'你是一位专业的写作助手。擅长结构化、清晰、有感染力的中文表达，依据场景调整语气与篇幅。' },
  { id:'analyst', emoji:'📊', name:'数据分析师', desc:'数据洞察：量化结论优先，给出可执行建议', prompt:'你是一位数据分析师。善于从数据 / 文件中提取洞察，优先给出量化结论与可执行建议。' }
];
function renderPresetAgents(){
  var el=document.getElementById('presetAgentGrid'); if(!el) return;
  el.innerHTML = PRESET_AGENT_TEMPLATES.map(function(t){
    var exists = _profiles.some(function(p){ return p.id===t.id; });
    var active = _profiles.some(function(p){ return p.id===t.id && (p.is_active || _persona===p.id); });
    // 卡片用纵向 flex：描述区 flex:1 撑开、按钮区 margin-top:auto 贴底，保证各卡片按钮垂直位置一致
    return '<div class="ext-card" style="border:1px solid var(--border);display:flex;flex-direction:column">'+
      '<div class="top"><div class="icon" style="font-size:22px">'+t.emoji+'</div><div><div class="name">'+esc(t.name)+'</div><div class="status '+(active?'on':'off')+'">'+(exists?(active?'● 使用中':'已创建'):'未创建')+'</div></div></div>'+
      '<div class="conn-desc" style="font-size:11px;opacity:.8;flex:1">'+esc(t.desc)+'</div>'+
      '<div style="margin-top:10px"><button class="action sm primary" onclick="applyPresetAgent(\''+t.id+'\')">'+(active?'使用中':(exists?'一键激活':'一键创建并激活'))+'</button></div>'+
      '</div>';
  }).join('');
}
function applyPresetAgent(id){
  var t = PRESET_AGENT_TEMPLATES.find(function(x){ return x.id===id; });
  if(!t) return;
  var existing = _profiles.find(function(p){ return p.id===t.id; });
  if(existing){
    selectPersona(t.id);
    toast('已激活模板 Agent：'+t.name);
    return;
  }
  toast('正在创建 Agent：'+t.name+'…');
  apiPost('/api/profiles', { id:t.id, name:t.name, emoji:t.emoji, prompt:t.prompt }).then(function(r){
    if(r && r.ok){
      fetchProfiles(function(){ selectPersona(t.id); renderPresetAgents(); });
      toast('模板已创建并激活：'+t.name+'（独立环境已就绪）');
    } else toast('创建失败：'+(r&&r.error||'未知'));
  }).catch(function(){ toast('创建失败：'+'网络错误'); });
}
function renderPersonas(){
  var el=document.getElementById('personaGrid'); if(!el) return;
  if(!_profilesLoaded){ fetchProfiles(function(){ renderPersonas(); }); el.innerHTML='<div class="empty-state">加载中…</div>'; return; }
  renderPresetAgents();
  el.innerHTML = _profiles.map(function(p){
    var active = p.is_active || (_persona===p.id);
    var canDelete = !p.is_default;
    var modelTag = p.model ? '<span class="badge" style="font-size:10px;background:var(--accent);color:#fff;margin-left:6px;padding:1px 5px;border-radius:3px">'+esc(p.model)+'</span>' : '';
    var skillsCount = (p.skills && p.skills.length) ? p.skills.length : 0;
    var infoTags = '<div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">';
    if(p.is_default) infoTags += '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:var(--border);color:var(--muted)">主目录</span>';
    infoTags += '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:var(--border);color:var(--muted);cursor:pointer" title="点击配置该 Agent 的专属 API 密钥" onclick="event.stopPropagation();openPersonaEnvEditor(\''+esc(p.id)+'\',\''+esc(p.name||p.id)+'\')">'+(p.has_api_key?'✅ API已配置':'⚠️ 未配置API')+'</span>';
    if(skillsCount) infoTags += '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:var(--border);color:var(--muted)">🛠 '+skillsCount+' 技能</span>';
    infoTags += '</div>';
    return '<div class="ext-card" style="border:'+(active?'1px solid var(--accent)':'1px solid var(--border)')+'">'+
      '<div class="top"><div class="icon" style="font-size:24px">'+(p.emoji||'🤖')+'</div><div><div class="name">'+esc(p.name||p.id)+modelTag+'</div><div class="status '+(active?'on':'off')+'">'+(active?'● 当前活跃 Agent':'点击切换')+'</div></div></div>'+
      '<div class="conn-desc" style="font-size:11px;opacity:.8">'+esc((p.prompt||'').slice(0,80))+'</div>'+
      infoTags+
      '<div class="persona-actions" style="margin-top:8px">'+
        '<button class="action sm" data-persona-action="edit" data-id="'+esc(p.id)+'">编辑</button>'+
        (canDelete?'<button class="action sm danger" data-persona-action="delete" data-id="'+esc(p.id)+'">删除</button>':'')+
        '<button class="action sm primary" data-persona-action="select" data-id="'+esc(p.id)+'">'+(active?'已选择':'选择')+'</button>'+
      '</div></div>';
  }).join('') + '<div class="ext-card add-card" onclick="openPersonaModal(\'\')" style="cursor:pointer;display:flex;align-items:center;justify-content:center;min-height:120px;border:1px dashed var(--border)"><span style="font-size:28px;opacity:.6">+</span><span style="margin-left:8px;opacity:.7">创建 Agent (Profile)</span></div>';
  if (!el._personaDelegated) {
    el._personaDelegated = true;
    el.addEventListener('click', function(ev){
      var btn = ev.target.closest('button[data-persona-action]');
      if (!btn || !el.contains(btn)) return;
      var id = btn.getAttribute('data-id');
      var action = btn.getAttribute('data-persona-action');
      if (action === 'edit') openPersonaModal(id);
      else if (action === 'delete') deletePersona(id);
      else if (action === 'select') selectPersona(id);
    });
  }
}
function openPersonaModal(id){
  try {
    var m=document.getElementById('personaModal'); if(!m){ toast('模态未就绪'); return; }
    if (m.parentElement !== document.body) document.body.appendChild(m);
    m.style.display='flex';
    document.getElementById('personaEditId').value = id||'';
    document.getElementById('personaModalTitle').textContent = id? '编辑 Agent (Profile)' : '创建 Agent (Profile)';
    var p = id ? _profiles.find(function(x){ return x.id===id; }) : null;
    document.getElementById('personaEmoji').value = p?(p.emoji||''):'🤖';
    document.getElementById('personaLabel').value = p?(p.name||''):'';
    document.getElementById('personaPrompt').value = p?(p.prompt||''):'';
    document.getElementById('personaDeleteBtn').style.display = (id && p && !p.is_default) ? 'inline-block' : 'none';
    // 动态插入模型字段和克隆选项（如果尚未插入）
    var promptEl = document.getElementById('personaPrompt');
    var extraWrap = document.getElementById('personaExtraFields');
    if(!extraWrap){
      extraWrap = document.createElement('div');
      extraWrap.id = 'personaExtraFields';
      promptEl.parentElement.after(extraWrap);
    }
    var extraHtml = '<div class="field" style="margin-top:10px"><label>模型（留空=跟随默认配置）</label>'+
      '<select id="personaModel" style="width:100%;padding:8px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border)">'+buildModelOptionsHtml(p?(p.model||''):'', '跟随默认配置')+'</select></div>';
    if(!id){
      // 新建时提供克隆选项
      extraHtml += '<div class="field" style="margin-top:10px"><label>创建方式</label>'+
        '<select id="personaCloneMode" style="width:100%;padding:8px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border)">'+
          '<option value="blank">空白创建（预置技能）</option>'+
          '<option value="clone">克隆配置（继承 API 密钥 + 模型 + SOUL.md）</option>'+
          '<option value="clone_all">完整克隆（配置 + 记忆 + 会话 + 技能）</option>'+
        '</select><div style="font-size:11px;color:var(--muted);margin-top:4px">克隆从当前默认 profile 复制配置，新 Agent 的会话和记忆独立</div></div>';
    }
    if(id && p && !p.is_default){
      // 编辑时显示技能列表和环境信息
      var skillsHtml = (p.skills && p.skills.length) ? p.skills.map(function(s){ return '<span style="font-size:10px;padding:2px 6px;border-radius:3px;background:var(--border);margin:2px">'+esc(s)+'</span>'; }).join('') : '<span style="font-size:11px;color:var(--muted)">无独立技能（继承预置）</span>';
      extraHtml += '<div class="field" style="margin-top:10px"><label>技能目录</label><div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:4px">'+skillsHtml+'</div></div>';
      extraHtml += '<div class="field" style="margin-top:8px"><label>环境状态</label><div style="font-size:11px;color:var(--muted);margin-top:4px">'+
        'API 密钥：'+(p.has_api_key?'<span style="color:#4caf50">已配置</span>':'<span style="color:#ff9800">未配置</span>')+
        (p.env_keys && p.env_keys.length ? ' · 环境变量：'+p.env_keys.length+' 个' : '')+
        ' <button class="action sm" onclick="openPersonaEnvEditor(\''+esc(id)+'\',\''+esc(p.name||'')+'\')" style="margin-left:6px">'+(p.has_api_key?'修改':'配置')+' API 密钥</button>'+
        '<div style="margin-top:4px;line-height:1.5">每个 Agent 是独立环境，可配置专属密钥；留空则回落到全局默认 .env 的密钥。</div>'+
        '</div></div>';
    }
    extraWrap.innerHTML = extraHtml;
  } catch(e){ toast('打开角色编辑失败：'+e.message); }
}
function closePersonaModal(){ var m=document.getElementById('personaModal'); if(m) m.style.display='none'; }
function savePersona(){
  var id=document.getElementById('personaEditId').value;
  var emoji=document.getElementById('personaEmoji').value.trim()||'🤖';
  var label=document.getElementById('personaLabel').value.trim();
  var prompt=document.getElementById('personaPrompt').value;
  var modelEl=document.getElementById('personaModel');
  var model=modelEl?modelEl.value.trim():'';
  if(!label){ toast('请填写 Agent 名称'); return; }
  if(id){
    // 更新已有 profile（SOUL.md + config + metadata）
    var payload = { name:label, emoji:emoji, prompt:prompt };
    if(model) payload.model = model;
    api('/api/profiles/'+encodeURIComponent(id), 'PUT', payload).then(function(r){
      if(r&&r.ok){ toast('已保存 Agent：'+label); closePersonaModal(); fetchProfiles(function(){ renderPersonas(); }); }
      else toast('保存失败：'+(r&&r.error||'未知'));
    }).catch(function(){ toast('保存失败'); });
  } else {
    // 创建新 profile（调用 hermes profile create）
    var newId = label.toLowerCase().replace(/[^a-z0-9_-]/g,'_').slice(0,24) || ('agent_'+Date.now());
    var cloneEl=document.getElementById('personaCloneMode');
    var cloneMode=cloneEl?cloneEl.value:'blank';
    var payload = { id:newId, name:label, emoji:emoji, prompt:prompt };
    if(model) payload.model = model;
    if(cloneMode==='clone') payload.clone = true;
    if(cloneMode==='clone_all') payload.clone_all = true;
    toast('正在创建 Agent…（hermes profile create）');
    apiPost('/api/profiles', payload).then(function(r){
      if(r&&r.ok){ toast('已创建 Agent：'+label+'（独立环境已就绪）'); closePersonaModal(); fetchProfiles(function(){ renderPersonas(); }); }
      else toast('创建失败：'+(r&&r.error||'未知'));
    });
  }
}
function deletePersona(id){
  if(!id) id = document.getElementById('personaEditId').value;
  if(!id) return;
  if(!confirm('确定删除该 Agent？\n\n这将停止其网关、移除服务、删除命令别名和所有配置数据。\n此操作不可恢复！')) return;
  fetch(apiUrl('/api/profiles/'+encodeURIComponent(id)), { method:'DELETE', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(r){
      if(r&&r.ok){ toast('已删除 Agent（hermes profile delete）'); closePersonaModal(); if(_persona===id){ _persona='default'; _personaPrompt=''; } fetchProfiles(function(){ renderPersonas(); }); }
      else toast('删除失败：'+(r&&r.error||'未知'));
    }).catch(function(){ toast('删除失败'); });
}
// ── 每个 Agent 的专属 API 密钥配置（独立 .env）──────────────────────────
var _envProfileId = null;
var _envProfileName = '';
function openPersonaEnvEditor(id, name){
  _envProfileId = id; _envProfileName = name || id;
  var m = document.getElementById('personaEnvModal');
  if(!m){
    m = document.createElement('div');
    m.id = 'personaEnvModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;z-index:9999';
    m.innerHTML = '<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;width:min(560px,92vw);max-height:84vh;display:flex;flex-direction:column">'+
      '<div id="envModalTitle" style="padding:14px 16px;font-weight:600;border-bottom:1px solid var(--border)">🔑 配置 API 密钥</div>'+
      '<div id="envModalBody" style="padding:14px 16px;overflow:auto;flex:1"></div>'+
      '<div id="envModalFoot" style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">'+
        '<button class="action" onclick="closePersonaEnvEditor()">取消</button>'+
        '<button class="action primary" onclick="savePersonaEnv()">保存并重启网关</button>'+
      '</div></div>';
    document.body.appendChild(m);
  }
  document.getElementById('envModalTitle').textContent = '🔑 '+name+' 的 API 密钥';
  var body = document.getElementById('envModalBody');
  body.innerHTML = '<div class="conn-hint" style="font-size:12px;margin-bottom:10px;line-height:1.6">每个 Agent 是独立环境，可配置专属密钥（写入该 Agent 的 .env，保存后网关自动重启生效）。<br>已有密钥仅显示前 4 位；输入新值覆盖，清空输入框并保存 = 删除该密钥（留空密钥时回落到全局默认 .env）。</div>';
  body.innerHTML += '<div style="font-size:12px;font-weight:600;margin-bottom:6px">常用密钥</div>';
  var commonKeys = ['OPENAI_API_KEY','ANTHROPIC_API_KEY','KIMI_API_KEY','MOONSHOT_API_KEY','MINIMAX_API_KEY','QWEN_API_KEY','DEEPSEEK_API_KEY','GLM_API_KEY','ZHIPU_API_KEY','XAI_API_KEY','GEMINI_API_KEY','OLLAMA_BASE_URL'];
  var known = {}; commonKeys.forEach(function(k){ known[k]=1; });
  body.innerHTML += '<div id="envCommonWrap" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">'+commonKeys.map(function(k){ return envKeyRowHtml(k, ''); }).join('')+'</div>';
  body.innerHTML += '<div style="font-size:12px;font-weight:600;margin-bottom:6px">自定义变量 <button class="action sm" onclick="addEnvCustomRow()">+ 添加</button></div>';
  body.innerHTML += '<div id="envCustomWrap" style="display:flex;flex-direction:column;gap:8px"></div>';
  // 读取当前值（脱敏）填入 placeholder
  apiGet('/api/profiles/'+encodeURIComponent(id)+'/env').then(function(res){
    if(!res || res.error) return;
    Object.keys(res.env||{}).forEach(function(k){
      var inp = document.getElementById('env_inp_'+k);
      if(inp){ inp.placeholder = res.env[k]; }
      else {
        // 自定义键已有值：追加一行
        addEnvCustomRow(k, res.env[k]);
      }
    });
  }).catch(function(){});
  m.style.display = 'flex';
}
function envKeyRowHtml(key, placeholder){
  return '<div style="display:flex;gap:8px;align-items:center"><label style="width:180px;font-size:11px;color:var(--muted);flex-shrink:0">'+esc(key)+'</label><input type="password" id="env_inp_'+esc(key)+'" class="env-inp" placeholder="'+(placeholder||'未配置')+'" style="flex:1;padding:7px 10px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border)"></div>';
}
function addEnvCustomRow(key, placeholder){
  var wrap = document.getElementById('envCustomWrap'); if(!wrap) return;
  var k = key || ''; var ph = placeholder || '';
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;align-items:center';
  row.innerHTML = '<input type="text" class="env-custom-key" placeholder="变量名（如 MY_API_KEY）" value="'+esc(k)+'" style="width:180px;padding:7px 10px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border);flex-shrink:0;font-size:12px">'+
    '<input type="password" class="env-inp" placeholder="'+(ph||'值')+'" style="flex:1;padding:7px 10px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border);font-size:12px">'+
    '<button class="action sm danger" onclick="this.parentElement.remove()" style="flex-shrink:0">✕</button>';
  wrap.appendChild(row);
}
function closePersonaEnvEditor(){ var m=document.getElementById('personaEnvModal'); if(m) m.style.display='none'; }
function savePersonaEnv(){
  var env = {};
  var skipped = 0;
  // 常用键区
  document.querySelectorAll('#envCommonWrap .env-inp').forEach(function(inp){
    var key = inp.id.replace('env_inp_','');
    var val = inp.value.trim();
    if(!val){ if(inp.placeholder && inp.placeholder !== '未配置' && inp.placeholder !== '值') env[key] = ''; else skipped++; return; }
    if(val === inp.placeholder) { skipped++; return; } // 未修改
    env[key] = val;
  });
  // 自定义键区：仅提交键名非空的行；值空且 placeholder 有原值 → 删除
  document.querySelectorAll('#envCustomWrap .env-custom-key').forEach(function(kInp, i){
    var key = kInp.value.trim();
    if(!key) return;
    var vInp = kInp.parentElement.querySelector('.env-inp');
    var val = vInp ? vInp.value.trim() : '';
    if(val){ env[key] = val; }
    else if(vInp && vInp.placeholder && vInp.placeholder !== '值'){ env[key] = ''; }
  });
  var keys = Object.keys(env);
  if(!keys.length){ toast('没有需要保存的变更'); return; }
  toast('正在保存 '+keys.length+' 个密钥…');
  api('/api/profiles/'+encodeURIComponent(_envProfileId)+'/env', 'PUT', { env: env }).then(function(r){
    if(r && r.ok){
      toast('已保存，网关正在重启生效');
      closePersonaEnvEditor();
      fetchProfiles(function(){ renderPersonas(); });
    } else toast('保存失败：'+(r&&r.error||'未知'));
  }).catch(function(){ toast('保存失败：网络错误'); });
}
function selectPersona(id){
  _persona = id;
  var p = _profiles.find(function(x){ return x.id===id; });
  _personaPrompt = (p && p.prompt) ? p.prompt : '';
  _cfg.extensions.persona = id;
  if(window.chatState) chatState.persona = id;
  try { localStorage.setItem('hermes_persona', id); } catch(e){}
  _selectedExpert = null;
  try { localStorage.removeItem('hermes_selected_expert'); } catch(e){}
  renderSelectedExpertBar();
  // 调用后端激活 profile（hermes profile use + 触发网关重载配置）
  toast('正在切换 Agent…（hermes profile use '+id+'）');
  apiPost('/api/profiles/'+encodeURIComponent(id)+'/activate', {}).then(function(r){
    if(r&&r.ok) toast('已切换到 Agent：'+(p?p.name:id)+'（网关将重载配置）');
  });
  fetchProfiles(function(){ renderPersonas(); });
  saveConfig();
}
var _expFilter=''; var _expDept='';
function renderExperts(){
  var el=document.getElementById('expertGrid'); if(!el) return;
  // 兜底（Issue #1）：若专家库尚未加载，轮询强制重新拉取（带缓存破坏），最多 5 次；避免一直停留 8 个样例
  if(!(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length)){
    if(!window.__personasRetry){
      window.__personasRetry = true;
      var tries = 0;
      (function poll(){
        ensurePersonasLibrary(function(){
          tries++;
          if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){
            renderExperts();
          } else if(tries < 5){
            setTimeout(poll, 600);
          } else {
            renderExperts(); // 最终以 PV.experts(8 个) 兜底，并保留重试标记以便下次进入时再试
          }
        });
      })();
    }
  }
  window.__expRendered = true;
  var list = expertsList();
  var cnt=document.getElementById('expCount');
  if(cnt){ cnt.textContent = (window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length) ? ('共 '+list.length+' 位专家') : '专家库加载中…'; }
  var deptWrap=document.getElementById('expDepts');
  var depts = (window.AGENCY_DEPTS && window.AGENCY_DEPTS.length) ? window.AGENCY_DEPTS : [];
  if(deptWrap){
    var dhtml='<div class="exp-dept'+(!_expDept?' active':'')+'" onclick="filterDept(this,\'\')">全部 <span class="cnt">'+list.length+'</span></div>';
    depts.forEach(function(d){ dhtml+='<div class="exp-dept'+(d.id===_expDept?' active':'')+'" onclick="filterDept(this,\''+esc(d.id)+'\')">'+esc(d.label||d.id)+' <span class="cnt">'+esc(d.count||'')+'</span></div>'; });
    deptWrap.innerHTML=dhtml;
  }
  var term=(document.getElementById('expSearch')?document.getElementById('expSearch').value:'').toLowerCase();
  var team=_cfg.extensions.team||[];
  var favs=_cfg.extensions.expert_favorites||[];
  el.innerHTML = list.filter(function(e){
    return (!_expDept || (e.deptId||'')===_expDept) && (!term || (e.name||'').toLowerCase().indexOf(term)>=0);
  }).map(function(e){
    var inTeam = team.some(function(m){ return m.id===e.id; });
    var isFav = favs.indexOf(e.id)>=0;
    return '<div class="ext-card">'+
      '<div class="top"><div class="icon">'+(e.icon||'🎯')+'</div><div><div class="name">'+esc(e.name)+'</div><div class="status">'+esc(e.dept||'')+'</div></div></div>'+
      '<div class="actions">'+
        '<button class="action" onclick="useExpert(\''+esc(e.id)+'\')">使用</button>'+
        '<button class="action secondary" onclick="favExpert(\''+esc(e.id)+'\')">'+(isFav?'已收藏':'收藏')+'</button>'+
        '<button class="action '+(inTeam?'danger':'')+'" onclick="toggleTeamMember(\''+esc(e.id)+'\')">'+(inTeam?'移出团队':'加入团队')+'</button>'+
      '</div></div>';
  }).join('') || '<div class="empty-state">没有匹配的专家。</div>';
  renderSelectedExpertBar();
}
function filterDept(el, dept){
  _expDept=dept;
  document.querySelectorAll('.exp-dept').forEach(function(d){ d.classList.remove('active'); });
  el.classList.add('active');
  renderExperts();
}
function useExpert(id){
  var list=expertsList(); var e=list.find(function(x){ return x.id===id; });
  if(!e) return;
  // 复用工具栏专家选择器逻辑：为专家创建独立会话分组（Issue #6）
  pickItemExpert(id, null);
}
function favExpert(id){
  if(!_cfg.extensions.expert_favorites) _cfg.extensions.expert_favorites=[];
  var arr=_cfg.extensions.expert_favorites;
  var idx=arr.indexOf(id);
  if(idx>=0) arr.splice(idx,1); else arr.push(id);
  saveConfig(); renderExperts();
  toast(idx>=0?'已取消收藏':'已收藏该专家');
}
function toggleTeamMember(id){
  var list=expertsList(); var e=list.find(function(x){ return x.id===id; }); if(!e) return;
  var team=_cfg.extensions.team||[];
  var idx=-1;
  for(var k=0;k<team.length;k++){ if(team[k].id===id){ idx=k; break; } }
  if(idx>=0) team.splice(idx,1); else team.push({ id:e.id, name:e.name, dept:e.dept, icon:e.icon });
  _cfg.extensions.team=team;
  renderExperts(); renderTeam(); saveConfig();
}
function clearSelectedExpert(){
  _selectedExpert=null; renderSelectedExpertBar(); toast('已清除选用的专家');
}
function renderSelectedExpertBar(){
  var bar=document.getElementById('selectedExpertBar'); if(!bar) return;
  if(_selectedExpert){
    bar.style.display='flex';
    bar.innerHTML='<span class="seb-label">当前已选用：</span><strong>'+esc(_selectedExpert.name||'')+'</strong><button class="action sm" onclick="clearSelectedExpert()">清除</button>';
  } else {
    bar.style.display='none'; bar.innerHTML='';
  }
}
function renderTeam(){
  var el=document.getElementById('teamGrid'); if(!el) return;
  var inp=document.getElementById('teamName'); if(inp) inp.value=_cfg.extensions.team_name||'我的团队';
  setToggle('teamEnabledToggle', !!_cfg.extensions.team_enabled);
  var team=_cfg.extensions.team||[];
  el.innerHTML = team.map(function(m){
    return '<div class="ext-card">'+
      '<div class="top"><div class="icon">'+(m.icon||'🎯')+'</div><div><div class="name">'+esc(m.name||'')+'</div><div class="status">'+esc(m.dept||'')+'</div></div></div>'+
      '<div class="actions"><button class="action" onclick="removeTeamMember(\''+esc(m.id)+'\')">移除</button></div>'+
      '</div>';
  }).join('') || '<div class="empty-state">团队为空，从「专家」页添加成员。</div>';
}
function buildAndUseTeam(){
  // 直接采用当前已选成员（用户在「专家」页手动添加、或「🎲 随机组建」后的结果）并启用，
  // 不在此处重新随机，避免覆盖用户手动挑选的专家团（修复：手动选好后点确认被随机刷掉）。
  _cfg.extensions.team_name = (document.getElementById('teamName').value)||'我的团队';
  if(!_cfg.extensions.team || !_cfg.extensions.team.length){
    toast('团队为空：请先从「专家」页添加成员，或点击「🎲 随机组建」');
    return;
  }
  _cfg.extensions.team_enabled=true;
  if(!_cfg.extensions.toolsets) _cfg.extensions.toolsets={};
  _cfg.extensions.toolsets.delegation=true;
  // 互斥：停用工作流
  if(_cfg.extensions.workflow&&_cfg.extensions.workflow.enabled){ _cfg.extensions.workflow.enabled=false; _cfg.extensions.workflow.active=false; renderWorkflowBar(); }
  setToggle('teamEnabledToggle', true);
  saveConfig(); renderTeam(); renderTeamBar();
  enterTeamSession();
  toast('已组建并启用专家团（'+_cfg.extensions.team.length+' 人）');
}
function toggleTeam(){
  if(_cfg.extensions.team_enabled===undefined) _cfg.extensions.team_enabled=false;
  _cfg.extensions.team_enabled=!_cfg.extensions.team_enabled;
  if(_cfg.extensions.team_enabled){
    if(!_cfg.extensions.toolsets)_cfg.extensions.toolsets={}; _cfg.extensions.toolsets.delegation=true;
    // 互斥：停用工作流
    if(_cfg.extensions.workflow&&_cfg.extensions.workflow.enabled){ _cfg.extensions.workflow.enabled=false; _cfg.extensions.workflow.active=false; renderWorkflowBar(); }
  }
  setToggle('teamEnabledToggle', _cfg.extensions.team_enabled);
  saveConfig(); renderTeam(); renderTeamBar();
  if(_cfg.extensions.team_enabled) enterTeamSession();
  toast(_cfg.extensions.team_enabled?'已启用专家团（已自动开启任务委派）':'已关闭专家团');
}
function _shuffleArr(a){ a=a.slice(); for(var i=a.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=a[i]; a[i]=a[j]; a[j]=t; } return a; }
function buildTeam(){
  _cfg.extensions.team_name = (document.getElementById('teamName').value)||'我的团队';
  var members;
  if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){
    // 每次点击随机挑选不同行业（部门），每个行业随机抽一位专家
    var byDept={};
    window.AGENCY_PERSONAS.forEach(function(p){ var d=p.dept||'其他'; if(!byDept[d]) byDept[d]=[]; byDept[d].push(p); });
    var depts=_shuffleArr(Object.keys(byDept)).slice(0,6);
    members=depts.map(function(d){ var arr=byDept[d]; return arr[Math.floor(Math.random()*arr.length)]; });
  } else {
    members=_shuffleArr(PV.experts.slice()).slice(0,3);
  }
  _cfg.extensions.team = members.map(function(p){ return { id:p.id, name:(p.label||p.name), dept:(p.dept_label||p.dept), icon:(p.emoji||p.icon) }; });
  renderTeam(); saveConfig(); toast('已随机组建 '+_cfg.extensions.team.length+' 人团队（每次行业不同），确认后点「🚀 组建并使用专家团」启用');
}
function clearTeam(){ _cfg.extensions.team=[]; renderTeam(); renderTeamBar(); saveConfig(); }
function removeTeamMember(id){ _cfg.extensions.team=(_cfg.extensions.team||[]).filter(function(x){ return x.id!==id; }); renderTeam(); renderTeamBar(); saveConfig(); }

/* ============================ MCP 服务器管理 ============================ */
var _mcpServers = [];
function renderMcpServers(){
  var el = document.getElementById('mcpServerList'); if(!el) return;
  apiGet('/api/mcp-servers').then(function(res){
    if(!res || !res.ok){ el.innerHTML='<div class="empty-state">加载失败</div>'; return; }
    _mcpServers = res.servers || [];
    if(!_mcpServers.length){ el.innerHTML='<div class="empty-state">尚未配置 MCP 服务器。点右上角「+ 添加服务器」开始配置。</div>'; return; }
    el.innerHTML = _mcpServers.map(function(s){
      var typeLabel = s.type==='http' ? '🌐 HTTP' : '⚙️ Stdio';
      var statusDot = s.enabled ? '<span style="color:#22c55e">●</span> 已启用' : '<span style="color:#ef4444">●</span> 已禁用';
      var detail = s.type==='http' ? esc(s.url) : esc(s.command + ' ' + (s.args||[]).join(' '));
      var toolsInfo = '';
      if(s.tools_include && s.tools_include.length) toolsInfo = '白名单: '+s.tools_include.join(', ');
      else if(s.tools_exclude && s.tools_exclude.length) toolsInfo = '黑名单: '+s.tools_exclude.join(', ');
      return '<div class="mcp-card'+(s.enabled?'':' disabled')+'">' +
        '<div class="mcp-card-head">' +
          '<div class="mcp-name">'+esc(s.name)+'</div>' +
          '<div class="mcp-badges"><span class="mcp-type">'+typeLabel+'</span><span class="mcp-status">'+statusDot+'</span></div>' +
        '</div>' +
        '<div class="mcp-detail">'+detail+'</div>' +
        (toolsInfo ? '<div class="mcp-tools-info">🔧 '+esc(toolsInfo)+'</div>' : '') +
        '<div class="mcp-actions">' +
          '<button class="ov-actbtn" onclick="openMcpModal(\''+esc(s.name)+'\')">编辑</button>' +
          '<button class="ov-actbtn" onclick="toggleMcpServer(\''+esc(s.name)+'\')">'+(s.enabled?'禁用':'启用')+'</button>' +
          '<button class="ov-actbtn stop" onclick="deleteMcpServer(\''+esc(s.name)+'\')">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }).catch(function(){ el.innerHTML='<div class="empty-state">加载失败</div>'; });
}
function openMcpModal(editName){
  var s = null;
  if(editName){ s = _mcpServers.find(function(x){ return x.name===editName; }); }
  var isEdit = !!s;
  var type = s ? s.type : 'stdio';
  var html = '<div class="modal-overlay" id="mcpModalOverlay" onclick="if(event.target===this)closeMcpModal()">' +
    '<div class="modal" style="max-width:560px;max-height:85vh;overflow-y:auto">' +
    '<div class="modal-head"><h3>'+(isEdit?'编辑 MCP 服务器':'添加 MCP 服务器')+'</h3><button class="modal-close" onclick="closeMcpModal()">×</button></div>' +
    '<div class="modal-body">' +
      '<div class="field"><label>服务器名称</label><input type="text" id="mcpName" value="'+esc(s?s.name:'')+'" placeholder="例如 github、filesystem" '+(isEdit?'disabled style="opacity:.6"':'')+'></div>' +
      '<div class="field"><label>类型</label><select id="mcpType" onchange="onMcpTypeChange()"><option value="stdio"'+(type==='stdio'?' selected':'')+'>Stdio（本地子进程）</option><option value="http"'+(type==='http'?' selected':'')+'>HTTP（远程端点）</option></select></div>' +
      '<div id="mcpStdioFields" style="display:'+(type==='stdio'?'block':'none')+'">' +
        '<div class="field"><label>Command</label><input type="text" id="mcpCommand" value="'+esc(s?s.command:'')+'" placeholder="例如 npx、node、python"></div>' +
        '<div class="field"><label>Args（每行一个参数）</label><textarea id="mcpArgs" rows="3" placeholder="-y\n@modelcontextprotocol/server-github">'+esc(s?(s.args||[]).join('\n'):'')+'</textarea></div>' +
        '<div class="field"><label>Env（每行 KEY=VALUE）</label><textarea id="mcpEnv" rows="3" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=***">'+esc(s?Object.entries(s.env||{}).map(function(e){return e[0]+'='+e[1];}).join('\n'):'')+'</textarea></div>' +
      '</div>' +
      '<div id="mcpHttpFields" style="display:'+(type==='http'?'block':'none')+'">' +
        '<div class="field"><label>URL</label><input type="text" id="mcpUrl" value="'+esc(s?s.url:'')+'" placeholder="https://mcp.example.com/mcp"></div>' +
        '<div class="field"><label>Headers（每行 Key: Value）</label><textarea id="mcpHeaders" rows="3" placeholder="Authorization: Bearer ***">'+esc(s?Object.entries(s.headers||{}).map(function(e){return e[0]+': '+e[1];}).join('\n'):'')+'</textarea></div>' +
      '</div>' +
      '<div class="field"><label>工具白名单（逗号分隔，留空=全部）</label><input type="text" id="mcpInclude" value="'+esc(s?(s.tools_include||[]).join(', '):'')+'" placeholder="create_issue, list_issues"></div>' +
      '<div class="field"><label>工具黑名单（逗号分隔）</label><input type="text" id="mcpExclude" value="'+esc(s?(s.tools_exclude||[]).join(', '):'')+'" placeholder="delete_customer"></div>' +
      '<div class="field"><label>超时（秒，可选）</label><input type="number" id="mcpTimeout" value="'+esc(s?s.timeout:'')+'" placeholder="30"></div>' +
    '</div>' +
    '<div class="modal-foot"><button class="action" onclick="closeMcpModal()">取消</button><button class="action primary" onclick="saveMcpServer('+(isEdit?"'"+esc(s.name)+"'":'null')+')">保存</button></div>' +
    '</div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
}
function closeMcpModal(){ var o=document.getElementById('mcpModalOverlay'); if(o) o.remove(); }
function onMcpTypeChange(){
  var t = document.getElementById('mcpType').value;
  document.getElementById('mcpStdioFields').style.display = t==='stdio'?'block':'none';
  document.getElementById('mcpHttpFields').style.display = t==='http'?'block':'none';
}
function saveMcpServer(editName){
  var name = document.getElementById('mcpName').value.trim();
  if(!name){ toast('请输入服务器名称','error'); return; }
  var type = document.getElementById('mcpType').value;
  var payload = { name: name, type: type };
  if(type==='stdio'){
    payload.command = document.getElementById('mcpCommand').value.trim();
    if(!payload.command){ toast('请输入 Command','error'); return; }
    var argsRaw = document.getElementById('mcpArgs').value.trim();
    payload.args = argsRaw ? argsRaw.split('\n').map(function(s){return s.trim();}).filter(Boolean) : [];
    var envRaw = document.getElementById('mcpEnv').value.trim();
    if(envRaw){ payload.env={}; envRaw.split('\n').forEach(function(line){ var idx=line.indexOf('='); if(idx>0) payload.env[line.slice(0,idx).trim()]=line.slice(idx+1).trim(); }); }
  } else {
    payload.url = document.getElementById('mcpUrl').value.trim();
    if(!payload.url){ toast('请输入 URL','error'); return; }
    var hdrRaw = document.getElementById('mcpHeaders').value.trim();
    if(hdrRaw){ payload.headers={}; hdrRaw.split('\n').forEach(function(line){ var idx=line.indexOf(':'); if(idx>0) payload.headers[line.slice(0,idx).trim()]=line.slice(idx+1).trim(); }); }
  }
  var inc = document.getElementById('mcpInclude').value.trim();
  if(inc) payload.tools_include = inc.split(',').map(function(s){return s.trim();}).filter(Boolean);
  var exc = document.getElementById('mcpExclude').value.trim();
  if(exc) payload.tools_exclude = exc.split(',').map(function(s){return s.trim();}).filter(Boolean);
  var timeout = document.getElementById('mcpTimeout').value.trim();
  if(timeout) payload.timeout = timeout;
  var url = editName ? '/api/mcp-servers/'+encodeURIComponent(editName) : '/api/mcp-servers';
  var method = editName ? 'PUT' : 'POST';
  fetch(apiUrl(url), { method: method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if(res.ok){ toast('✅ MCP 服务器已保存，网关将自动重启生效'); closeMcpModal(); renderMcpServers(); }
      else toast(res.error||'保存失败','error');
    }).catch(function(e){ toast('网络错误: '+e.message,'error'); });
}
function toggleMcpServer(name){
  fetch(apiUrl('/api/mcp-servers/'+encodeURIComponent(name)+'/toggle'), { method:'POST' })
    .then(function(r){ return r.json(); })
    .then(function(res){ if(res.ok){ toast(res.enabled?'✅ 已启用 '+name:'⛔ 已禁用 '+name); renderMcpServers(); } else toast(res.error||'操作失败','error'); })
    .catch(function(e){ toast('网络错误','error'); });
}
function deleteMcpServer(name){
  if(!confirm('确定删除 MCP 服务器「'+name+'」？\n删除后网关将自动重启。')) return;
  fetch(apiUrl('/api/mcp-servers/'+encodeURIComponent(name)), { method:'DELETE' })
    .then(function(r){ return r.json(); })
    .then(function(res){ if(res.ok){ toast('🗑 已删除 '+name); renderMcpServers(); } else toast(res.error||'删除失败','error'); })
    .catch(function(e){ toast('网络错误','error'); });
}

/* ============================ 定时任务管理 ============================ */
var _cronJobs = [];
function renderCronJobs(){
  var el = document.getElementById('cronJobList'); if(!el) return;
  apiGet('/api/cron-jobs').then(function(res){
    if(!res || !res.ok){ el.innerHTML='<div class="empty-state">加载失败</div>'; return; }
    _cronJobs = res.jobs || [];
    var cronWebhooks = res.webhooks || {};
    if(!_cronJobs.length){ el.innerHTML='<div class="empty-state">尚无定时任务。点右上角「+ 创建任务」开始配置。</div>'; return; }
    var delIcons = { local:'💾', origin:'💬', weixin:'💬', telegram:'✈️', discord:'🎮', feishu:'📘', dingtalk:'📱', wecom:'💼' };
    el.innerHTML = _cronJobs.map(function(j){
      var id = j.id || j.job_id || '';
      var name = j.name || j.prompt || '未命名任务';
      if(name.length > 60) name = name.slice(0,60) + '…';
      var schedule = j.schedule || j.cron || '';
      var paused = j.paused || j.status === 'paused';
      var skills = j.skills || j.attached_skills || [];
      var deliver = j.deliver_to || j.delivery || 'local';
      var nextRun = j.next_run_at ? new Date(j.next_run_at).toLocaleString('zh-CN') : '';
      var lastRun = j.last_run_at ? new Date(j.last_run_at).toLocaleString('zh-CN') : '';
      var lastStatus = j.last_status || '';
      var lastError = j.last_error || '';
      var accent = paused ? '#f59e0b' : '#22c55e';
      // 状态 pill（参考 Octop CronJobCard：圆点 + 状态色）
      var statusPill = '<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;padding:2px 9px;border-radius:10px;color:'+accent+';background:'+accent+'1a;font-weight:600;letter-spacing:.2px">'+
        '<span style="width:6px;height:6px;border-radius:50%;background:'+accent+'"></span>'+(paused?'已暂停':'活跃')+'</span>';
      // Webhook 投递通道状态（monitor 轮询转发）
      var hooks = (cronWebhooks[id] || []).filter(function(h){ return h && h.url; });
      var hookHtml = '';
      if(hooks.length){
        hookHtml = hooks.map(function(h){
          var hok = h.last_status === 'ok', herr = h.last_status === 'error';
          var color = herr ? '#ef4444' : (hok ? '#22c55e' : 'var(--text3)');
          var state = herr ? '失败' : (hok ? '已投递' : '等待');
          return '<span style="font-size:11px;color:var(--text3)">🔗 '+esc(h.label || 'Webhook')+' <b style="color:'+color+'">'+state+'</b>'+
            (herr && h.last_error ? ' <span title="'+esc(h.last_error)+'" style="cursor:help;color:#ef4444">⚠️</span>' : '')+'</span>';
        }).join('<span style="color:var(--border)">|</span>');
      }
      return '<div class="mcp-card'+(paused?' disabled':'')+'" style="border-left:3px solid '+accent+'">' +
        '<div class="mcp-card-head"><div class="mcp-name">⏰ '+esc(name)+'</div><div class="mcp-badges">'+statusPill+'</div></div>' +
        '<div class="mcp-detail" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:6px">'+
          '<code style="font-size:11px;background:var(--bg1);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-family:monospace">'+esc(schedule)+'</code>'+
          '<span style="font-size:11px;color:var(--text3)">'+(delIcons[deliver]||'📨')+' 投递: '+esc(deliver)+'</span>'+
        '</div>' +
        (skills.length ? '<div class="mcp-tools-info" style="margin-top:4px">📚 技能: '+esc(skills.join(', '))+'</div>' : '') +
        (hookHtml ? '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">'+hookHtml+'</div>' : '') +
        '<div style="font-size:11px;color:var(--text3);display:flex;gap:14px;flex-wrap:wrap;margin-top:4px">' +
          (nextRun ? '<span>⏭ 下次: '+esc(nextRun)+'</span>' : '') +
          (lastRun ? '<span>⏮ 上次: '+esc(lastRun)+'</span>' : '') +
          (lastStatus ? '<span>结果: <b style="color:'+(lastStatus==='ok'?'#22c55e':(lastStatus==='error'?'#ef4444':'var(--text3)'))+'">'+esc(lastStatus)+'</b></span>' : '') +
        '</div>' +
        (lastStatus==='error' && lastError ? '<div style="font-size:11px;color:#ef4444;background:#ef44441a;border-radius:6px;padding:5px 9px;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(lastError)+'">⚠️ '+esc(lastError)+'</div>' : '') +
        '<div class="mcp-actions" style="margin-top:8px">' +
          (paused ? '<button class="ov-actbtn start" onclick="cronAction(\''+esc(id)+'\',\'resume\')">恢复</button>' : '<button class="ov-actbtn" onclick="cronAction(\''+esc(id)+'\',\'pause\')">暂停</button>') +
          '<button class="ov-actbtn" onclick="cronAction(\''+esc(id)+'\',\'run\')">立即执行</button>' +
          '<button class="ov-actbtn stop" onclick="cronAction(\''+esc(id)+'\',\'remove\')">删除</button>' +
        '</div></div>';
    }).join('');
  }).catch(function(){ el.innerHTML='<div class="empty-state">加载失败</div>'; });
}
function cronAction(jobId, action){
  if(action==='remove' && !confirm('确定删除该定时任务？')) return;
  fetch(apiUrl('/api/cron-jobs/'+encodeURIComponent(jobId)+'/action'), {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:action})
  }).then(function(r){ return r.json(); }).then(function(res){
    if(res.ok){ toast('✅ 操作成功: '+action); renderCronJobs(); } else toast(res.error||'操作失败','error');
  }).catch(function(e){ toast('网络错误','error'); });
}
function openCronModal(){
  _cronSched = null; _cronSchedTab = 'period'; // 每次打开重置调度器状态
  window._cronDeliverList = [{channel:'local',url:'',message:''}];
  var templates = [
    {icon:'📰', name:'每日 AI 新闻推送', desc:'科技/AI/财经要闻摘要', schedule:'0 8 * * *', prompt:'搜索今日科技、AI、财经领域的重要新闻，生成一份简洁的每日新闻摘要（5-10条），包含标题、一句话摘要和重要性评级。', deliver:['weixin']},
    {icon:'📖', name:'每日 5 个英语单词', desc:'单词+释义+例句推送', schedule:'0 7 * * *', prompt:'挑选 5 个适合日常交流的英语单词，每个给出音标、中文释义、2 个实用例句，并生成一段用这 5 个词写的小短文。', deliver:[{channel:'webhook', url:'', message:'{output}'}]},
    {icon:'🌙', name:'每日儿童睡前故事', desc:'生成温馨童话故事', schedule:'0 20 * * *', prompt:'写一个适合 3-8 岁儿童的睡前故事（600字以内），主题积极温暖，结尾附一句晚安祝福。', deliver:['weixin']},
    {icon:'📋', name:'每周工作周报', desc:'回顾本周工作输出', schedule:'0 17 * * 5', prompt:'回顾本周所有会话记录，总结本周完成的主要工作、遇到的问题和下周计划，生成结构化周报。', deliver:['local']},
    {icon:'🖥️', name:'NAS 健康检查', desc:'磁盘/内存/服务状态', schedule:'every 6h', prompt:'检查 NAS 系统状态：磁盘使用率、内存占用、CPU 温度、关键服务运行状态。如有异常立即告警。', deliver:['local']},
    {icon:'🐙', name:'GitHub 仓库监控', desc:'Release/Issue/PR 动态', schedule:'every 2h', prompt:'检查关注的 GitHub 仓库是否有新的 Release、重要 Issue 或 PR。如有新动态生成摘要报告。', deliver:['telegram']},
    {icon:'📄', name:'每日 AI 论文精选', desc:'arXiv 论文中文解读', schedule:'0 9 * * *', prompt:'搜索 arXiv 上最新的 AI/LLM 相关论文，筛选出 3-5 篇最有价值的，生成中文解读摘要。', deliver:['weixin']},
    {icon:'🏛️', name:'历史上的今天', desc:'历史事件时间线推送', schedule:'0 8 * * *', prompt:'查询今天在历史上发生的重要事件（至少 5 条，覆盖科技、文化、社会），按时间线整理成简短的推送文案。', deliver:[{channel:'webhook', url:'', message:'{output}'}]},
    {icon:'💾', name:'定时数据备份提醒', desc:'检查备份完成情况', schedule:'0 2 * * 0', prompt:'检查本周是否已完成重要数据备份，如未完成则生成备份操作指南并提醒用户执行。', deliver:['local']},
    {icon:'📊', name:'竞品动态监控', desc:'竞品更新与分析简报', schedule:'0 10 * * 1,3,5', prompt:'搜索并分析主要竞品（AI Agent、NAS 应用）的最新动态、产品更新和市场变化，生成竞品分析简报。', deliver:['feishu']},
    {icon:'🧾', name:'每月账单汇总', desc:'API 用量与费用估算', schedule:'0 10 1 * *', prompt:'汇总上个月的 API 调用量、Token 消耗、各模型使用占比，生成月度用量报告和费用估算。', deliver:['weixin']},
    {icon:'🔐', name:'服务器安全扫描', desc:'异常登录/端口/证书', schedule:'0 3 * * *', prompt:'执行基础安全检查：异常登录记录、开放端口扫描、过期证书检查、系统更新状态。生成安全报告。', deliver:['local']}
  ];
  var tplHtml = templates.map(function(t,i){
    return '<div class="cron-tpl-card" onclick="applyCronTemplate('+i+')">' +
      '<div class="cron-tpl-icon">'+t.icon+'</div>' +
      '<div class="cron-tpl-name">'+esc(t.name)+'</div>' +
      '<div class="cron-tpl-desc">'+esc(t.desc)+'</div>' +
      '<div class="cron-tpl-sched">'+esc(t.schedule)+'</div>' +
    '</div>';
  }).join('');
  window._cronTemplates = templates;
  var html = '<div class="modal-overlay" id="cronModalOverlay" onclick="if(event.target===this)closeCronModal()">' +
    '<div class="modal" style="max-width:660px;max-height:88vh;overflow-y:auto">' +
    '<div class="modal-head"><h3>添加自动化任务</h3><button class="modal-close" onclick="closeCronModal()">×</button></div>' +
    '<div class="modal-body">' +
      '<div style="background:var(--accent-bg);color:var(--accent);border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.7;margin-bottom:12px">🧩 支持<b>多通道投递</b>：可同时推送到微信 / Telegram / 钉钉 / 企业微信等多个通道，每个通道独立定制消息；还支持 <b>Webhook POST</b>（企业微信机器人、钉钉机器人），消息模板用 <code>{output}</code> 引用任务输出。</div>' +
      '<div class="field"><label>📌 模板（点击一键填充）</label><div class="cron-tpl-grid">'+tplHtml+'</div></div>' +
      '<div class="field cron-form-group"><label>任务名称（可选）</label><input type="text" id="cronName" placeholder="例如：每日 AI 新闻推送"></div>' +
      '<div class="field cron-form-group"><label>执行频率 *</label><div id="cronSchedWrap"></div></div>' +
      '<div class="field cron-form-group"><label>提示词 *</label><textarea id="cronPrompt" rows="4" placeholder="代理每次运行时应执行什么操作？"></textarea></div>' +
      '<div class="field cron-form-group"><label>投递到（可添加多个通道，每个通道独立消息）</label><div id="cronDeliverWrap"></div><button type="button" class="action sm" onclick="cronAddDeliver()">＋ 添加投递通道</button></div>' +
      '<div class="field cron-form-group"><label>技能（可选，逗号分隔）</label><input type="text" id="cronSkills" placeholder="例如 blogwatcher, find-nearby"></div>' +
      '<div class="field cron-form-group"><label>重复次数（可选，留空=无限）</label><input type="number" id="cronRepeat" placeholder="留空表示无限重复" min="1"></div>' +
    '</div>' +
    '<div class="modal-foot"><button class="action" onclick="closeCronModal()">取消</button><button class="action primary" onclick="createCronJob()">创建任务</button></div>' +
    '</div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
  renderCronSched();
  renderCronDelivers();
}
// ── 可视化调度构建器（WorkBuddy 风格：频率 Tab = 周期 / 按间隔 / 单次 + 实时预览）──
var _cronSched = null;
var _cronSchedTab = 'period';
function cronSchedState(){
  if(!_cronSched) _cronSched = { mode:'interval', intervalValue:2, intervalUnit:'hours', timeOfDay:'09:00', weekdays:[1,2,3,4,5], dayOfMonth:1, onceAt:'', custom:'' };
  return _cronSched;
}
function buildScheduleString(){
  var s = cronSchedState();
  if(s.mode==='interval'){
    var um = { minutes:'m', hours:'h', days:'d' };
    return 'every ' + s.intervalValue + (um[s.intervalUnit]||'h');
  }
  var hm = (s.timeOfDay||'09:00').split(':');
  var hh = parseInt(hm[0])||0, mm = parseInt(hm[1])||0;
  if(s.mode==='daily') return mm + ' ' + hh + ' * * *';
  if(s.mode==='weekly') return mm + ' ' + hh + ' * * ' + (s.weekdays.length ? s.weekdays.join(',') : '*');
  if(s.mode==='monthly') return mm + ' ' + hh + ' ' + s.dayOfMonth + ' * *';
  if(s.mode==='once') return s.onceAt;
  return s.custom;
}
function cronSchedPreview(){
  var s = cronSchedState();
  if(s.mode==='interval') return '每 '+s.intervalValue+' '+({minutes:'分钟',hours:'小时',days:'天'}[s.intervalUnit]||s.intervalUnit)+'执行一次';
  if(s.mode==='daily') return '每天 '+s.timeOfDay+' 执行';
  if(s.mode==='weekly') return '每周 '+(s.weekdays.length ? s.weekdays.map(function(d){ return ['日','一','二','三','四','五','六'][d]; }).join('、') : '（未选，视为每天）')+' '+s.timeOfDay+' 执行';
  if(s.mode==='monthly') return '每月 '+s.dayOfMonth+' 日 '+s.timeOfDay+' 执行';
  if(s.mode==='once') return '一次性：'+(s.onceAt||'（请选择时间）');
  return '自定义：'+(s.custom||'（未填写）');
}
function cronSchedTabOf(mode){ return (mode==='interval')?'interval':(mode==='once')?'once':'period'; }
function cronSchedTab(tab){
  var s = cronSchedState();
  if(tab==='interval') s.mode='interval';
  else if(tab==='once') s.mode='once';
  else if(s.mode==='interval'||s.mode==='once') s.mode='daily';
  renderCronSched();
}
function renderCronSched(){
  var wrap = document.getElementById('cronSchedWrap'); if(!wrap) return;
  var s = cronSchedState();
  _cronSchedTab = cronSchedTabOf(s.mode);
  var html = '<div class="cron-tabs">' +
    [['period','🔄 周期'],['interval','⏱ 按间隔'],['once','🎯 单次']].map(function(t){
      return '<button type="button" class="cron-tab'+(t[0]===_cronSchedTab?' active':'')+'" onclick="cronSchedTab(\''+t[0]+'\')">'+t[1]+'</button>';
    }).join('') + '</div>';
  if(_cronSchedTab==='interval'){
    html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">每 <input type="number" id="cronIvVal" min="1" max="9999" value="'+s.intervalValue+'" style="width:70px" onchange="cronSchedPatch({intervalValue:parseInt(this.value)||1})"> '+
      '<select id="cronIvUnit" onchange="cronSchedPatch({intervalUnit:this.value})" style="padding:6px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border)">'+
      '<option value="minutes"'+(s.intervalUnit==='minutes'?' selected':'')+'>分钟</option>'+
      '<option value="hours"'+(s.intervalUnit==='hours'?' selected':'')+'>小时</option>'+
      '<option value="days"'+(s.intervalUnit==='days'?' selected':'')+'>天</option>'+
      '</select> 执行一次</div>';
  } else if(_cronSchedTab==='once'){
    html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">执行时间 <input type="datetime-local" id="cronOnceAt" value="'+s.onceAt+'" onchange="cronSchedPatch({onceAt:this.value})" style="padding:6px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border)"></div>';
  } else {
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">';
    [['daily','📅 每天'],['weekly','🗓 每周'],['monthly','📆 每月'],['custom','✍️ 自定义']].forEach(function(m){
      html += '<button type="button" class="action sm '+(s.mode===m[0]?'primary':'')+'" onclick="cronSchedMode(\''+m[0]+'\')">'+m[1]+'</button>';
    });
    html += '</div>';
    if(s.mode==='daily'){
      html += '<div style="display:flex;gap:8px;align-items:center">每天 <input type="time" id="cronTime" value="'+s.timeOfDay+'" onchange="cronSchedPatch({timeOfDay:this.value||\'09:00\'})" style="padding:6px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border)"> 执行</div>';
    } else if(s.mode==='weekly'){
      html += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">';
      ['日','一','二','三','四','五','六'].forEach(function(dn,i){
        var on = s.weekdays.indexOf(i)>=0;
        html += '<button type="button" class="action sm '+(on?'primary':'')+'" style="min-width:34px" onclick="cronSchedToggleWeekday('+i+')">'+dn+'</button>';
      });
      html += '</div><div style="display:flex;gap:8px;align-items:center">时间 <input type="time" id="cronTime" value="'+s.timeOfDay+'" onchange="cronSchedPatch({timeOfDay:this.value||\'09:00\'})" style="padding:6px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border)"></div>';
    } else if(s.mode==='monthly'){
      html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">每月 <input type="number" id="cronDom" min="1" max="31" value="'+s.dayOfMonth+'" style="width:70px" onchange="cronSchedPatch({dayOfMonth:parseInt(this.value)||1})"> 日 <input type="time" id="cronTime" value="'+s.timeOfDay+'" onchange="cronSchedPatch({timeOfDay:this.value||\'09:00\'})" style="padding:6px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border)"> 执行</div>';
    } else {
      html += '<input type="text" id="cronCustom" value="'+esc(s.custom)+'" placeholder="例如 0 9 * * *、every 30m、2026-08-05T10:00" onchange="cronSchedPatch({custom:this.value})" style="width:100%;padding:8px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border)">';
    }
  }
  html += '<div style="margin-top:8px;font-size:12px;color:var(--accent);background:var(--accent-bg);border-radius:6px;padding:6px 10px;line-height:1.5">'+cronSchedPreview()+'<br><code style="font-size:11px;opacity:.8">'+esc(buildScheduleString())+'</code></div>';
  wrap.innerHTML = html;
}
function cronSchedMode(mode){ var s=cronSchedState(); s.mode = mode; _cronSchedTab = cronSchedTabOf(mode); renderCronSched(); }
function cronSchedPatch(patch){ var s = cronSchedState(); for(var k in patch) s[k] = patch[k]; renderCronSched(); }
function cronSchedToggleWeekday(d){ var s = cronSchedState(); var i = s.weekdays.indexOf(d); if(i>=0) s.weekdays.splice(i,1); else s.weekdays.push(d); renderCronSched(); }
function cronSchedFromString(str){
  // 从已有调度字符串解析出构建器状态（模板点击时调用）
  var s = cronSchedState(); str = (str||'').trim(); s.custom = str;
  var m = str.match(/^every\s+(\d+)\s*([mhd])$/i);
  if(m){ s.mode='interval'; s.intervalValue=parseInt(m[1])||1; s.intervalUnit=({m:'minutes',h:'hours',d:'days'}[m[2].toLowerCase()]||'hours'); return; }
  if(str.indexOf('T')>=0 || /^\d{4}-\d{2}-\d{2}/.test(str)){ s.mode='once'; s.onceAt=str.length>=16?str.slice(0,16):str; return; }
  var parts = str.split(/\s+/);
  if(parts.length>=5 && parts.slice(0,5).every(function(p){ return /^[\d\*\-,/]+$/.test(p); })){
    // cron → 尝试识别为 daily/weekly/monthly
    var mm=parts[0], hh=parts[1], dom=parts[2], mon=parts[3], dow=parts[4];
    if(dom==='*' && mon==='*' && dow==='*' && /^\d+$/.test(hh) && /^\d+$/.test(mm)){
      s.mode='daily'; s.timeOfDay=(hh.length<2?'0':'')+hh+':'+(mm.length<2?'0':'')+mm;
    } else if(dom==='*' && mon==='*' && /^[\d,]+$/.test(dow) && !dow.includes('-')){
      s.mode='weekly'; s.timeOfDay=(hh.length<2?'0':'')+hh+':'+(mm.length<2?'0':'')+mm;
      s.weekdays = dow.split(',').map(function(x){return parseInt(x);}).filter(function(x){return x>=0&&x<=6;});
    } else if(dow==='*' && mon==='*' && /^\d+$/.test(dom)){
      s.mode='monthly'; s.timeOfDay=(hh.length<2?'0':'')+hh+':'+(mm.length<2?'0':'')+mm; s.dayOfMonth=parseInt(dom)||1;
    } else { s.mode='custom'; }
    return;
  }
  s.mode='custom';
}
// ── 多通道投递（内置通道 + Webhook 机器人：企业微信/钉钉）──
var CRON_DELIVER_CHANNELS = [
  { id:'local',    label:'本地保存',       icon:'💾' },
  { id:'origin',   label:'原始会话',       icon:'💬' },
  { id:'weixin',   label:'微信',           icon:'💚' },
  { id:'telegram', label:'Telegram',       icon:'✈️' },
  { id:'dingtalk', label:'钉钉',           icon:'🐜' },
  { id:'wecom',    label:'企业微信',       icon:'🏢' },
  { id:'feishu',   label:'飞书',           icon:'📘' },
  { id:'discord',  label:'Discord',        icon:'🎮' },
  { id:'webhook',  label:'Webhook 机器人', icon:'🔗' }
];
function cronDeliverRowHTML(row, i){
  var opts = CRON_DELIVER_CHANNELS.map(function(c){
    return '<option value="'+c.id+'"'+(row.channel===c.id?' selected':'')+'>'+c.icon+' '+esc(c.label)+'</option>';
  }).join('');
  var h = '<div class="cron-deliver-row">' +
    '<select onchange="cronDeliverChanged('+i+')">'+opts+'</select>';
  if(row.channel==='webhook'){
    h += '<input type="text" style="flex:1;min-width:200px" placeholder="Webhook 地址（企业微信机器人 / 钉钉机器人，以 http(s):// 开头）" value="'+esc(row.url||'')+'" oninput="cronDeliverInput('+i+',\'url\',this.value)">' +
      '<input type="text" class="cron-deliver-msg" placeholder="消息模板：{output} = 任务输出全文（留空默认输出全文）" value="'+esc(row.message||'')+'" oninput="cronDeliverInput('+i+',\'message\',this.value)">';
  }
  h += '<button type="button" class="cron-deliver-del" title="移除该通道" onclick="cronDeliverRemove('+i+')">×</button></div>';
  return h;
}
function renderCronDelivers(){
  var wrap = document.getElementById('cronDeliverWrap'); if(!wrap) return;
  if(!window._cronDeliverList) window._cronDeliverList = [{channel:'local',url:'',message:''}];
  wrap.innerHTML = window._cronDeliverList.map(cronDeliverRowHTML).join('');
}
function cronAddDeliver(){
  if(!window._cronDeliverList) window._cronDeliverList = [];
  window._cronDeliverList.push({channel:'local',url:'',message:''});
  renderCronDelivers();
}
function cronDeliverRemove(i){
  var list = window._cronDeliverList || [];
  list.splice(i,1);
  if(!list.length) list.push({channel:'local',url:'',message:''});
  renderCronDelivers();
}
function cronDeliverChanged(i){
  var list = window._cronDeliverList || [];
  var rows = document.querySelectorAll('#cronDeliverWrap .cron-deliver-row');
  if(rows[i]){
    list[i].channel = rows[i].querySelector('select').value;
    var inputs = rows[i].querySelectorAll('input');
    if(inputs.length>=1) list[i].url = inputs[0].value;
    if(inputs.length>=2) list[i].message = inputs[1].value;
  }
  renderCronDelivers();
}
function cronDeliverInput(i, field, val){
  var list = window._cronDeliverList || [];
  if(list[i]) list[i][field] = val;
}
function applyCronTemplate(i){
  var t = window._cronTemplates[i]; if(!t) return;
  document.getElementById('cronName').value = t.name;
  document.getElementById('cronPrompt').value = t.prompt;
  window._cronDeliverList = (t.deliver||['local']).map(function(d){
    if(typeof d === 'string') return { channel:d, url:'', message:'' };
    return { channel:d.channel||'local', url:d.url||'', message:d.message||'' };
  });
  renderCronDelivers();
  cronSchedFromString(t.schedule);
  renderCronSched();
  toast('✅ 已填充模板：'+t.name);
}
function closeCronModal(){ var o=document.getElementById('cronModalOverlay'); if(o) o.remove(); }
function createCronJob(){
  var prompt = document.getElementById('cronPrompt').value.trim();
  var schedule = buildScheduleString().trim();
  if(!prompt){ toast('请输入提示词','error'); return; }
  if(!schedule){ toast('请输入调度方式','error'); return; }
  if(_cronSched && _cronSched.mode==='once' && !_cronSched.onceAt){ toast('请选择一次性执行的时间','error'); return; }
  var payload = { prompt: prompt, schedule: schedule };
  var name = document.getElementById('cronName').value.trim();
  if(name) payload.name = name;
  // 多通道投递：内置通道 + Webhook（企微/钉钉机器人，独立消息模板）
  var deliveries = [], firstBuiltin = null, errMsg = null;
  var rows = document.querySelectorAll('#cronDeliverWrap .cron-deliver-row');
  for(var ri=0;ri<rows.length;ri++){
    var row = rows[ri];
    var sel = row.querySelector('select'); if(!sel) continue;
    var ch = sel.value;
    if(ch==='webhook'){
      var inputs = row.querySelectorAll('input');
      var url = (inputs[0]?inputs[0].value:'').trim();
      if(!/^https?:\/\//i.test(url)){ errMsg = 'Webhook 投递需填写以 http(s):// 开头的机器人地址'; break; }
      var msg = (inputs[1]?inputs[1].value:'').trim();
      deliveries.push({ channel:'webhook', url:url, message:msg||'{output}', label:url.replace(/^https?:\/\//i,'').slice(0,40) });
    } else {
      if(!firstBuiltin) firstBuiltin = ch;
      deliveries.push({ channel:ch });
    }
  }
  if(errMsg){ toast(errMsg,'error'); return; }
  if(!deliveries.length) deliveries.push({ channel:'local' });
  payload.deliveries = deliveries;
  payload.deliver_to = firstBuiltin || 'local';
  var skillsRaw = document.getElementById('cronSkills').value.trim();
  if(skillsRaw) payload.skills = skillsRaw.split(',').map(function(s){return s.trim();}).filter(Boolean);
  var repeat = document.getElementById('cronRepeat').value.trim();
  if(repeat) payload.repeat = parseInt(repeat);
  fetch(apiUrl('/api/cron-jobs'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if(res.ok){ toast('✅ 定时任务已创建'+(res.webhooks_attached?('，已关联 '+res.webhooks_attached+' 个 Webhook 投递'):'')); closeCronModal(); renderCronJobs(); }
      else toast(res.error||'创建失败','error');
    }).catch(function(e){ toast('网络错误: '+e.message,'error'); });
}

/* ============================ 记忆页面 ============================ */
var _memData = { soul:'', memory:'', notes:'' };
function renderMemoryPage(){
  apiGet('/api/memory').then(function(res){
    if(!res || !res.ok){ toast('加载记忆失败','error'); return; }
    _memData = { soul: res.soul||'', memory: res.memory||'', notes: res.notes||'' };
    var el;
    el=document.getElementById('memSoul'); if(el) el.value=_memData.soul;
    el=document.getElementById('memMemory'); if(el) el.value=_memData.memory;
    el=document.getElementById('memNotes'); if(el) el.value=_memData.notes;
  }).catch(function(e){ toast('网络错误','error'); });
}
function saveMemoryField(field){
  var elId = field==='soul'?'memSoul':field==='memory'?'memMemory':'memNotes';
  var el = document.getElementById(elId); if(!el) return;
  var payload = {}; payload[field] = el.value;
  fetch(apiUrl('/api/memory'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(res){ if(res.ok) toast('✅ '+field+' 已保存'); else toast(res.error||'保存失败','error'); })
    .catch(function(e){ toast('网络错误','error'); });
}
function saveAllMemory(){
  var payload = {
    soul: (document.getElementById('memSoul')||{}).value||'',
    memory: (document.getElementById('memMemory')||{}).value||'',
    notes: (document.getElementById('memNotes')||{}).value||''
  };
  fetch(apiUrl('/api/memory'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(res){ if(res.ok) toast('✅ 全部记忆已保存'); else toast(res.error||'保存失败','error'); })
    .catch(function(e){ toast('网络错误','error'); });
}

/* ============================ Token 用量 ============================ */
function renderUsageCard(){
  apiGet('/api/usage').then(function(res){
    if(!res || !res.ok || !res.usage){ return; }
    var u = res.usage;
    var el;
    el=document.getElementById('usageSessions'); if(el) el.textContent = u.total_sessions||0;
    el=document.getElementById('usageMessages'); if(el) el.textContent = u.total_messages||0;
    var models = u.by_model ? Object.keys(u.by_model) : [];
    el=document.getElementById('usageModels'); if(el) el.textContent = models.length;
    el=document.getElementById('usageByModel');
    if(el && models.length){
      el.innerHTML = models.map(function(m){
        var info = u.by_model[m];
        return '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>'+esc(m)+'</span><span>'+info.sessions+'会话 / '+info.messages+'消息</span></div>';
      }).join('');
    }
  }).catch(function(){});
}

/* ============================ 用量统计页 ============================ */
function renderUsagePage(){
  var cardsEl = document.getElementById('usageSummaryCards');
  var modelSection = document.getElementById('usageByModelSection');
  var modelList = document.getElementById('usageByModelList');
  var dailySection = document.getElementById('usageDailySection');
  var dailyBody = document.getElementById('usageDailyBody');
  var emptyEl = document.getElementById('usageEmpty');
  
  cardsEl.innerHTML = '<div class="usage-card"><div class="usage-card-label">加载中...</div></div>';
  modelSection.style.display = 'none';
  dailySection.style.display = 'none';
  emptyEl.style.display = 'none';
  
  apiGet('/api/usage').then(function(res){
    if(!res || !res.ok || !res.usage){
      cardsEl.innerHTML = '';
      emptyEl.style.display = '';
      return;
    }
    var u = res.usage;
    var totalSessions = u.total_sessions || 0;
    var totalMessages = u.total_messages || 0;
    var models = u.by_model ? Object.keys(u.by_model) : [];
    
    // 汇总卡片
    cardsEl.innerHTML = 
      '<div class="usage-card"><div class="usage-card-label">总会话数</div><div class="usage-card-value">'+totalSessions+'</div></div>' +
      '<div class="usage-card"><div class="usage-card-label">总消息数</div><div class="usage-card-value">'+totalMessages+'</div></div>' +
      '<div class="usage-card"><div class="usage-card-label">使用模型数</div><div class="usage-card-value">'+models.length+'</div></div>' +
      '<div class="usage-card"><div class="usage-card-label">Dashboard 状态</div><div class="usage-card-value" style="font-size:16px">'+(res.note||'已连接')+'</div></div>';
    
    // 模型分布
    if(models.length){
      var maxSessions = 0;
      models.forEach(function(m){ if(u.by_model[m].sessions > maxSessions) maxSessions = u.by_model[m].sessions; });
      modelList.innerHTML = models.map(function(m){
        var info = u.by_model[m];
        var pct = maxSessions > 0 ? Math.round(info.sessions / maxSessions * 100) : 0;
        return '<div class="usage-model-row">' +
          '<div class="usage-model-name">'+esc(m)+'</div>' +
          '<div class="usage-model-bar"><div class="usage-model-bar-fill" style="width:'+pct+'%"></div></div>' +
          '<div class="usage-model-stats">'+info.sessions+' 会话 · '+info.messages+' 消息</div>' +
          '</div>';
      }).join('');
      modelSection.style.display = '';
    }
    
    // 每日用量（从会话数据推算）
    if(u.daily && u.daily.length){
      dailyBody.innerHTML = u.daily.map(function(d){
        return '<tr><td>'+esc(d.date)+'</td><td>'+d.sessions+'</td><td>'+d.messages+'</td><td>'+esc(d.models||'-')+'</td></tr>';
      }).join('');
      dailySection.style.display = '';
    }
  }).catch(function(){
    cardsEl.innerHTML = '';
    emptyEl.style.display = '';
  });
}

/* ============================ 学习轨迹 ============================ */
var LEARN_COLORS = { skills:'#f59e0b', 'software-development':'#3b82f6', media:'#8b5cf6', creative:'#ec4899', devops:'#10b981', productivity:'#06b6d4', memory:'#6366f1', other:'#6b7280' };
var LEARN_EXTRA_COLORS = ['#ef4444','#14b8a6','#f97316','#a3e635','#d946ef','#0ea5e9','#84cc16','#f43f5e'];
function _ensureCatColor(cat){
  if(!LEARN_COLORS[cat]){
    var h=0; for(var i=0;i<cat.length;i++) h=(h*31+cat.charCodeAt(i))>>>0;
    LEARN_COLORS[cat]=LEARN_EXTRA_COLORS[h%LEARN_EXTRA_COLORS.length];
  }
  return LEARN_COLORS[cat];
}
var LEARN_CAT_LABELS = { skills:'技能', 'software-development':'软件开发', media:'媒体', creative:'创意', devops:'DevOps', productivity:'效率', memory:'记忆', other:'其他' };
var _learnCatFilter = null;
var _learnRaf = 0;
var _learnState = null; // { nodes, nodeMap, edges, els }
function _learnColor(cat){ return LEARN_COLORS[cat] || LEARN_COLORS.other; }
function _shadeHex(hex, amt){
  var n = parseInt(hex.slice(1),16), r=n>>16, g=(n>>8)&255, b=n&255;
  function f(v){ v = amt>0 ? v+(255-v)*amt : v*(1+amt); return Math.round(Math.max(0,Math.min(255,v))); }
  return 'rgb('+f(r)+','+f(g)+','+f(b)+')';
}
function renderLearning(){
  var statsEl = document.getElementById('learnStats');
  var graphEl = document.getElementById('learnGraph');
  if(!graphEl) return;
  _learnCatFilter = null;
  if(_learnRaf){ cancelAnimationFrame(_learnRaf); _learnRaf=0; }
  graphEl.innerHTML = '<div class="empty-state">加载中…</div>';
  apiGet('/api/learning-trajectory').then(function(res){
    if(!res || !res.ok){ graphEl.innerHTML='<div class="empty-state">加载失败</div>'; return; }
    var skills = res.skills || [];
    var relations = res.relations || [];
    skills.forEach(function(s){ _ensureCatColor(s.category||'other'); });
    var totalUsage = skills.reduce(function(a,s){ return a+(s.usage_count||0); },0);
    // 统计栏（分类徽章可点击筛选）
    if(statsEl){
      var cats = {};
      skills.forEach(function(s){ var c=s.category||'other'; if(!cats[c]) cats[c]={count:0,usage:0}; cats[c].count++; cats[c].usage+=(s.usage_count||0); });
      var catHtml = '<span class="learn-cat-badge on" data-cat="" onclick="setLearnFilter(\'\')"><span class="learn-cat-dot" style="background:var(--text3)"></span>全部 '+skills.length+'</span>';
      catHtml += Object.keys(cats).sort(function(a,b){ return cats[b].usage-cats[a].usage; }).map(function(c){
        var pct = totalUsage ? Math.round(cats[c].usage/totalUsage*100) : 0;
        return '<span class="learn-cat-badge" data-cat="'+esc(c)+'" onclick="setLearnFilter(\''+esc(c).replace(/'/g,"\\'")+'\')"><span class="learn-cat-dot" style="background:'+_learnColor(c)+'"></span>'+esc(LEARN_CAT_LABELS[c]||c)+' '+cats[c].count+' / '+pct+'%</span>';
      }).join('');
      statsEl.innerHTML = '<div class="learn-summary"><strong>'+skills.length+'</strong> 技能 · <strong>'+relations.length+'</strong> 关系 · <strong>'+totalUsage+'</strong> 次使用</div><div class="learn-cats">'+catHtml+'</div>';
    }
    if(!skills.length){ graphEl.innerHTML='<div class="empty-state">尚无技能数据</div>'; return; }
    renderSkillGraph(graphEl, skills, relations);
  }).catch(function(e){ graphEl.innerHTML='<div class="empty-state">网络错误</div>'; });
}
function setLearnFilter(cat){
  _learnCatFilter = (cat && cat!==_learnCatFilter) ? cat : null;
  document.querySelectorAll('.learn-cat-badge').forEach(function(b){
    b.classList.toggle('on', (b.getAttribute('data-cat')||'')===(_learnCatFilter||''));
  });
  applyLearnFilter();
}
function applyLearnFilter(){
  var st=_learnState; if(!st) return;
  var f=_learnCatFilter;
  st.nodes.forEach(function(n){
    var dim = f && n.category!==f;
    n.el.style.opacity = dim ? '0.14' : '1';
    n.el.style.pointerEvents = dim ? 'none' : '';
  });
  st.edges.forEach(function(e){
    var dim = f && (e.a.category!==f && e.b.category!==f);
    e.el.setAttribute('opacity', dim ? '0.05' : '0.5');
  });
}
function renderSkillGraph(container, skills, relations){
  var W=900, H=560, NS='http://www.w3.org/2000/svg';
  var maxUsage = Math.max.apply(null, skills.map(function(s){ return s.usage_count||1; }));
  // 初始位置：按分类分簇 + 抖动，收敛更快
  var catIndex = {};
  skills.forEach(function(s){ var c=s.category||'other'; catIndex[c]=(catIndex[c]||[]); catIndex[c].push(s); });
  var catKeys = Object.keys(catIndex);
  var nodes = [];
  catKeys.forEach(function(c, ci){
    var ang = (2*Math.PI*ci)/Math.max(1,catKeys.length) - Math.PI/2;
    var bcx = W/2 + Math.cos(ang)*Math.min(W,H)*0.28, bcy = H/2 + Math.sin(ang)*Math.min(W,H)*0.28;
    catIndex[c].forEach(function(s, i){
      var radius = 3 + Math.sqrt((s.usage_count||1)/maxUsage)*3;
      nodes.push({ id:s.id, name:s.name||s.id, category:s.category||'other', usage:s.usage_count||0, skill:s,
        x: bcx + (Math.random()-0.5)*50, y: bcy + (Math.random()-0.5)*50, vx:0, vy:0, fx:null, fy:null, r:radius });
    });
  });
  var nodeMap = {}; nodes.forEach(function(n){ nodeMap[n.id]=n; });
  var edges = [];
  relations.forEach(function(rel){
    var a=nodeMap[rel.from], b=nodeMap[rel.to];
    if(a && b && a!==b) edges.push({ a:a, b:b });
  });

  var svg = document.createElementNS(NS,'svg');
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.setAttribute('preserveAspectRatio','xMidYMid meet');
  svg.style.width='100%'; svg.style.height='100%'; svg.style.display='block';
  // 渐变 defs（3D 球体感）
  var defs = document.createElementNS(NS,'defs');
  Object.keys(LEARN_COLORS).forEach(function(c){
    var col = LEARN_COLORS[c];
    var g = document.createElementNS(NS,'radialGradient');
    g.setAttribute('id','lg-'+c); g.setAttribute('cx','35%'); g.setAttribute('cy','28%'); g.setAttribute('r','80%');
    var s1=document.createElementNS(NS,'stop'); s1.setAttribute('offset','0%'); s1.setAttribute('stop-color',_shadeHex(col,0.55));
    var s2=document.createElementNS(NS,'stop'); s2.setAttribute('offset','45%'); s2.setAttribute('stop-color',col);
    var s3=document.createElementNS(NS,'stop'); s3.setAttribute('offset','100%'); s3.setAttribute('stop-color',_shadeHex(col,-0.35));
    g.appendChild(s1); g.appendChild(s2); g.appendChild(s3); defs.appendChild(g);
  });
  svg.appendChild(defs);
  var edgeLayer = document.createElementNS(NS,'g'); svg.appendChild(edgeLayer);
  var nodeLayer = document.createElementNS(NS,'g'); svg.appendChild(nodeLayer);
  edges.forEach(function(e){
    var ln=document.createElementNS(NS,'line');
    ln.setAttribute('stroke','var(--border2)'); ln.setAttribute('stroke-width','1'); ln.setAttribute('opacity','0.5');
    edgeLayer.appendChild(ln); e.el=ln;
  });
  nodes.forEach(function(n){
    var g=document.createElementNS(NS,'g'); g.setAttribute('class','learn-node'); g.setAttribute('data-id',n.id);
    var shadow=document.createElementNS(NS,'ellipse');
    shadow.setAttribute('rx',n.r*0.8); shadow.setAttribute('ry',n.r*0.3); shadow.setAttribute('fill','rgba(0,0,0,.12)');
    shadow.setAttribute('cx','0'); shadow.setAttribute('cy',String(n.r+3));
    var c=document.createElementNS(NS,'circle');
    c.setAttribute('r',n.r); c.setAttribute('fill','url(#lg-'+n.category+')');
    c.setAttribute('stroke',_shadeHex(_learnColor(n.category),-0.25)); c.setAttribute('stroke-width','0.5');
    g.appendChild(shadow); g.appendChild(c);
    if(n.r>=4){
      var t=document.createElementNS(NS,'text');
      t.setAttribute('text-anchor','middle'); t.setAttribute('y',String(n.r+10));
      t.setAttribute('font-size','11'); t.setAttribute('fill','var(--text2)');
      t.textContent = n.name.length>12 ? n.name.slice(0,12)+'…' : n.name;
      g.appendChild(t);
    }
    nodeLayer.appendChild(g); n.el=g;
  });
  container.innerHTML='';
  container.appendChild(svg);
  // 图例
  var legend=document.createElement('div'); legend.className='learn-legend';
  legend.innerHTML = catKeys.slice(0,6).map(function(c){ return '<span><span class="lg-dot" style="background:'+_learnColor(c)+'"></span>'+esc(LEARN_CAT_LABELS[c]||c)+'</span>'; }).join('');
  container.appendChild(legend);

  _learnState = { nodes:nodes, nodeMap:nodeMap, edges:edges };
  applyLearnFilter();

  // 力导向模拟
  var alpha = 1;
  function simTick(){
    var i, j, a, b, dx, dy, d2, d, f;
    // 库仑排斥
    for(i=0;i<nodes.length;i++){
      for(j=i+1;j<nodes.length;j++){
        a=nodes[i]; b=nodes[j];
        dx=b.x-a.x; dy=b.y-a.y; d2=dx*dx+dy*dy;
        if(d2<1){ dx=(Math.random()-0.5); dy=(Math.random()-0.5); d2=1; }
        d=Math.sqrt(d2);
        f = 600/d2 * alpha;
        var fx=dx/d*f, fy=dy/d*f;
        a.vx-=fx; a.vy-=fy; b.vx+=fx; b.vy+=fy;
      }
    }
    // 连线弹簧
    edges.forEach(function(e){
      dx=e.b.x-e.a.x; dy=e.b.y-e.a.y; d=Math.sqrt(dx*dx+dy*dy)||1;
      var rest = 30 + e.a.r + e.b.r;
      f = (d-rest)*0.015*alpha;
      e.a.vx += dx/d*f; e.a.vy += dy/d*f;
      e.b.vx -= dx/d*f; e.b.vy -= dy/d*f;
    });
    // 向心 + 积分
    nodes.forEach(function(n){
      n.vx += (W/2-n.x)*0.0016*alpha;
      n.vy += (H/2-n.y)*0.0016*alpha;
      if(n.fx!=null){ n.x=n.fx; n.y=n.fy; n.vx=0; n.vy=0; return; }
      n.vx*=0.82; n.vy*=0.82;
      n.x+=n.vx; n.y+=n.vy;
      var m=n.r+4;
      if(n.x<m){n.x=m;n.vx=0;} if(n.x>W-m){n.x=W-m;n.vx=0;}
      if(n.y<m){n.y=m;n.vy=0;} if(n.y>H-m){n.y=H-m;n.vy=0;}
    });
  }
  function draw(){
    nodes.forEach(function(n){ n.el.setAttribute('transform','translate('+n.x.toFixed(1)+','+n.y.toFixed(1)+')'); });
    edges.forEach(function(e){
      e.el.setAttribute('x1',e.a.x); e.el.setAttribute('y1',e.a.y);
      e.el.setAttribute('x2',e.b.x); e.el.setAttribute('y2',e.b.y);
    });
  }
  function loop(){
    if(alpha>0.02){ simTick(); alpha*=0.985; draw(); _learnRaf=requestAnimationFrame(loop); }
    else { _learnRaf=0; draw(); }
  }
  function reheat(v){ if(alpha<v) alpha=v; if(!_learnRaf) _learnRaf=requestAnimationFrame(loop); }
  draw();
  _learnRaf=requestAnimationFrame(loop);

  // 拖拽 + 点击（pointer events，坐标换算到 viewBox）
  function svgPoint(evt){
    var pt=svg.createSVGPoint(); pt.x=evt.clientX; pt.y=evt.clientY;
    var m=svg.getScreenCTM(); if(!m) return {x:0,y:0};
    var p=pt.matrixTransform(m.inverse()); return {x:p.x, y:p.y};
  }
  nodes.forEach(function(n){
    var dragging=false, moved=0, sx=0, sy=0;
    n.el.addEventListener('pointerdown', function(evt){
      evt.preventDefault();
      dragging=true; moved=0; var p=svgPoint(evt); sx=p.x; sy=p.y;
      n.fx=n.x; n.fy=n.y;
      try{ n.el.setPointerCapture(evt.pointerId); }catch(e){}
    });
    n.el.addEventListener('pointermove', function(evt){
      if(!dragging) return;
      var p=svgPoint(evt);
      moved += Math.abs(p.x-sx)+Math.abs(p.y-sy); sx=p.x; sy=p.y;
      n.fx=p.x; n.fy=p.y; reheat(0.25);
    });
    n.el.addEventListener('pointerup', function(){
      if(!dragging) return;
      dragging=false;
      if(moved<5){ n.fx=null; n.fy=null; showSkillDetail(n.skill); }
      // 拖拽后钉住位置，保持用户布局
    });
  });
}
function showSkillDetail(skill){
  var el=document.getElementById('learnDetail'); if(!el) return;
  var cat=skill.category||'other';
  el.style.display='';
  el.innerHTML = '<div class="mem-card"><div class="mem-card-head"><span class="mem-icon">📌</span><span class="mem-title">'+esc(skill.name||skill.id)+'</span><button class="modal-close" onclick="document.getElementById(\'learnDetail\').style.display=\'none\'">\u00d7</button></div>' +
    '<div style="padding:12px;font-size:13px">' +
    '<div><strong>ID:</strong> '+esc(skill.id)+'</div>' +
    '<div><strong>分类:</strong> <span class="learn-cat-badge" style="cursor:default;padding:1px 8px"><span class="learn-cat-dot" style="background:'+_learnColor(cat)+'"></span>'+esc(LEARN_CAT_LABELS[cat]||cat)+'</span></div>' +
    '<div><strong>使用次数:</strong> '+(skill.usage_count||0)+'</div>' +
    '<div><strong>来源:</strong> '+esc(skill.source||'-')+'</div>' +
    '<div><strong>创建时间:</strong> '+(skill.created_at?new Date(skill.created_at).toLocaleString():'-')+'</div>' +
    (skill.description?'<div style="margin-top:6px;color:var(--text2)">'+esc(skill.description)+'</div>':'') +
    '</div></div>';
}

/* 保存扩展/设置相关配置 */
function saveConfig(){
  var payload = JSON.parse(JSON.stringify(_cfg));
  // 默认仅 Hermes Gateway 激活时，GET 不返回 hermes provider（被前端过滤），
  // 但后端 POST 要求 active_provider 命中 providers 中某一项，否则 400「no active provider」。
  // 补回 hermes 内部 provider 占位，使后端 active_provider 校验通过
  // （hermes 不会被写入 providers 段，model.provider 仍指向 hermes）。
  var hasActive = payload.active_provider && payload.providers && payload.providers.some(function(p){ return p && p.name===payload.active_provider; });
  if(!hasActive){
    payload.providers = payload.providers || [];
    var hasHermes = payload.providers.some(function(p){ return p && p.id==='hermes'; });
    if(!hasHermes){
      payload.providers.push({ id:'hermes', name:'Hermes Gateway', type:'openai-compatible', base_url:'LOCAL', model:'auto', temperature:0.7, max_tokens:4096, api_key_configured:false });
    }
    if(!payload.active_provider) payload.active_provider = 'Hermes Gateway';
  }
  return apiPost('/api/config', payload).then(function(r){
    if(r && r.error) toast('保存配置失败：'+r.error);
    // 工具集有新增（如启用专家团开启 delegation）时后端会重启网关以加载新工具，
    // 给用户明确反馈，避免网关重启的几秒内发消息失败造成困惑
    else if(r && r.gateway_restarting) toast('正在重启网关以加载新工具（如任务委派），请稍候几秒再发送');
  }).catch(function(e){ toast('保存配置失败：'+e.message); });
}

/* ============================ 连接器（OCTOP） ============================ */
var _connFilter='all';
function renderConnectors(){
  var el=document.getElementById('connectorGrid'); if(!el) return;
  apiGet('/api/connectors').then(function(d){
    var list = (d && d.connectors) || [];
    _connState.list = list;
    var metaMap = {};
    PV.octopConnectors.forEach(function(c){ metaMap[c.kind]=c; });
    var items = PV.octopConnectors.filter(function(c){
      var cfg = list.find(function(x){ return x.kind===c.kind; });
      var configured = !!(cfg && cfg.configured);
      if(_connFilter==='configured' && !configured) return false;
      if(_connFilter==='unconfigured' && configured) return false;
      return true;
    });
    el.innerHTML = items.map(function(c){
      var cfg = list.find(function(x){ return x.kind===c.kind; });
      var configured = !!(cfg && cfg.configured);
      return '<div class="connector-card" onclick="openConnectorModal(\''+c.kind+'\')">'+
        '<div class="top"><div class="icon" style="color:'+esc(c.color)+'">'+c.icon+'</div><div><div class="name">'+esc(c.name)+'<span class="badge">'+esc(c.mcp_mode)+'</span></div><div class="status">'+esc(c.description)+'</div></div></div>'+
        '<button class="action" onclick="event.stopPropagation();openConnectorModal(\''+c.kind+'\')">'+(configured?'管理':'去配置')+'</button></div>';
    }).join('') || '<div class="empty-state">该筛选下暂无连接器。</div>';
  }).catch(function(){ toast('加载连接器失败'); });
}
function setConnFilter(el, filter){
  _connFilter=filter;
  document.querySelectorAll('#page-connectors .ch-filter').forEach(function(b){ b.classList.remove('active'); });
  el.classList.add('active');
  renderConnectors();
}
var _currentConnKind=null;
function openConnectorModal(kind){
  _currentConnKind=kind;
  var c=PV.octopConnectors.find(function(x){ return x.kind===kind; });
  var m=document.getElementById('connectorModal'); if(!m) return;
  if (m.parentElement !== document.body) document.body.appendChild(m);
  m.style.display='flex';
  document.getElementById('connModalTitle').innerHTML=esc(c.name)+' <span class="conn-badge" style="background:'+esc(c.color)+'20;color:'+esc(c.color)+';border-color:'+esc(c.color)+'40">'+esc(c.mcp_mode)+'</span>';
  apiGet('/api/connectors/'+encodeURIComponent(kind)).then(function(d){
    var creds=(d && d.creds_set) || {};
    renderConnectorDetail(c, creds, d);
  }).catch(function(){
    renderConnectorDetail(c, {}, null);
  });
}
function renderConnectorDetail(c, creds, d){
  creds = creds || {};
  var body='<div class="conn-desc">'+esc(c.description)+'</div>';
  body+='<a class="conn-doc" href="'+esc(c.doc_url)+'" target="_blank">📄 查看官方文档 →</a>';
  body+='<div class="conn-hint">💡 '+esc(c.auth_hint)+'</div>';
  body+='<div class="conn-section-title">凭证</div><div class="conn-fields">';
  c.fields.forEach(function(f){
    // creds_set 是「是否已设置」的布尔标志（后端出于安全不回显真实密钥），
    // 绝不能当作输入框的值回填（否则 Client ID 会变成 "true" 并在保存时覆盖真实凭证）。
    var isSet=!!creds[f.key];
    var ph=f.placeholder||'';
    if(isSet) ph='已设置，留空则保留原值'+(ph?'（'+ph+'）':'');
    body+='<div class="field"><label>'+esc(f.label)+(isSet?' <span style="color:var(--success);font-size:11px">✓ 已设置</span>':'')+'</label><input type="'+(f.secret?'password':'text')+'" id="connField_'+f.key+'" value="" placeholder="'+esc(ph)+'"></div>';
  });
  body+='</div>';
  body+='<div class="conn-section-title">工具列表</div><div class="conn-tools">';
  if(c.mcp_mode==='remote'){
    body+='<div class="conn-tool remote">远程 MCP：保存后将注册为 MCP 服务器，由对话中的智能体调用。</div>';
  } else {
    c.tools.forEach(function(t){
      body+='<div class="conn-tool"><div class="tool-name">'+esc(t.name)+'</div><div class="tool-desc">'+esc(t.description)+'</div></div>';
    });
  }
  body+='</div>';
  if(c.mcp_mode==='gateway'){
    body+='<div class="conn-section-title">调用工具</div><div class="conn-invoke">';
    body+='<div class="field"><label>选择工具</label><select id="connToolSelect" onchange="onConnToolChange()">';
    c.tools.forEach(function(t,i){ body+='<option value="'+i+'">'+esc(t.name)+'</option>'; });
    body+='</select></div><div id="connToolArgs"></div>';
    body+='<button class="action primary" style="margin-top:10px" onclick="invokeConnectorTool()">调用工具</button>';
    body+='<pre id="connToolResult" class="conn-result" style="display:none"></pre></div>';
  }
  document.getElementById('connModalBody').innerHTML=body;
  if(c.mcp_mode==='gateway') onConnToolChange();
  var foot=document.getElementById('connModalFoot');
  if(foot) foot.innerHTML='<button class="action" onclick="testConnector()">测试连接</button><button class="action primary" onclick="saveConnector()">保存</button>';
}
function onConnToolChange(){
  var c=PV.octopConnectors.find(function(x){ return x.kind===_currentConnKind }); if(!c) return;
  var idx=parseInt(document.getElementById('connToolSelect').value,10);
  var tool=c.tools[idx]; if(!tool) return;
  var html='';
  tool.args.forEach(function(a){
    html+='<div class="field"><label>'+esc(a.label)+(a.required?'<span style="color:#ef4444">*</span>':'')+'</label>'+(a.textarea?'<textarea id="connArg_'+a.key+'" rows="3" placeholder="'+esc(a.placeholder||'')+'"></textarea>':'<input type="text" id="connArg_'+a.key+'" placeholder="'+esc(a.placeholder||'')+'">')+'</div>';
  });
  document.getElementById('connToolArgs').innerHTML=html;
}
function getConnFields(){
  var c=PV.octopConnectors.find(function(x){ return x.kind===_currentConnKind }); if(!c) return {};
  var fields={};
  c.fields.forEach(function(f){ var el=document.getElementById('connField_'+f.key); if(el) fields[f.key]=el.value.trim(); });
  return fields;
}
function closeConnectorModal(){ var m=document.getElementById('connectorModal'); if(m) m.style.display='none'; _currentConnKind=null; }
function testConnector(){
  var c=PV.octopConnectors.find(function(x){ return x.kind===_currentConnKind });
  if(c && c.mcp_mode==='remote'){ toast('远程 MCP 连接器无需测试，保存后由网关注册为 MCP 服务器。'); return; }
  var fields=getConnFields();
  apiPost('/api/connectors/'+encodeURIComponent(_currentConnKind), fields).then(function(r){
    if(r && r.ok) toast('连接测试成功');
    else if(r && r.error) toast('测试失败：'+r.error);
    else toast('已提交（部署后生效）');
  }).catch(function(e){ toast('测试请求失败：'+e.message); });
}
function saveConnector(){
  var fields=getConnFields();
  apiPost('/api/connectors/'+encodeURIComponent(_currentConnKind), fields).then(function(r){
    if(r && r.error) toast('保存失败：'+r.error);
    else { toast('已保存连接器凭证'); closeConnectorModal(); renderConnectors(); }
  }).catch(function(e){ toast('保存失败：'+e.message); });
}
function invokeConnectorTool(){
  var c=PV.octopConnectors.find(function(x){ return x.kind===_currentConnKind });
  var idx=parseInt(document.getElementById('connToolSelect').value,10);
  var tool=c.tools[idx];
  var args={}; var missing=false;
  tool.args.forEach(function(a){
    var el=document.getElementById('connArg_'+a.key);
    var v=el?el.value.trim():'';
    if(a.required && !v) missing=true;
    if(v) args[a.key]=v;
  });
  if(missing){ toast('请填写必填参数'); return; }
  var res=document.getElementById('connToolResult'); res.style.display='block'; res.textContent='调用中…';
  apiPost('/api/connectors/'+encodeURIComponent(_currentConnKind)+'/call', { tool:tool.name, args:args }).then(function(r){
    if(r && r.ok){ try { res.textContent = typeof r.result==='string' ? r.result : JSON.stringify(r.result,null,2); } catch(e){ res.textContent=String(r.result); } }
    else if(r && r.error){ res.textContent='调用失败：'+r.error; }
    else res.textContent='调用完成（无返回）';
  }).catch(function(e){ res.textContent='调用失败：'+e.message; });
}

/* ============================ 通讯 / 渠道 ============================ */
var _chFilter='all';
function renderChannels(){
  var el=document.getElementById('channelGrid'); if(!el) return;
  apiGet('/api/channels').then(function(res){
    if(!res || res.error){ el.innerHTML='<div class="empty-state" style="color:var(--red)">加载频道失败：'+(res&&res.error||'未知')+'</div>'; return; }
    _chState.defs = res.defs || {};
    _chState.channels = res.channels || {};
    var defs=_chState.defs, ch=_chState.channels;
    var ids=Object.keys(defs);
    if(_chFilter==='configured') ids=ids.filter(function(id){ return !!((ch[id]||{}).configured); });
    else if(_chFilter==='unconfigured') ids=ids.filter(function(id){ return !((ch[id]||{}).configured); });
    ids.sort(function(a,b){ return ((ch[b]||{}).configured?1:0) - ((ch[a]||{}).configured?1:0); });
    el.innerHTML = ids.map(function(id){
      var def=defs[id]; var c=ch[id]||{}; var configured=!!c.configured;
      var badge=configured?'<span class="badge on">已配置</span>':'<span class="badge off">未配置</span>';
      var action=def.qrLogin?'<button class="action" onclick="event.stopPropagation();openChannelModal(\''+id+'\')">扫码登录</button>':'<button class="action" onclick="event.stopPropagation();openChannelModal(\''+id+'\')">配置</button>';
      var svgIcon = (window.PV && PV.ICONS && PV.ICONS[id]) ? PV.ICONS[id] : null;
      var iconHtml = svgIcon ? '<div class="icon svg-icon">'+svgIcon+'</div>' : '<div class="icon">'+(def.icon||'🔌')+'</div>';
      return '<div class="connector-card" onclick="openChannelModal(\''+id+'\')">'+
        '<div class="top">'+iconHtml+'<div><div class="name">'+esc(def.name)+' '+badge+'</div><div class="status">'+(def.note||'配置后可在该平台收发消息')+'</div></div></div>'+
        action+'</div>';
    }).join('') || '<div class="empty-state">该筛选下暂无频道。</div>';
  }).catch(function(){ toast('加载频道失败'); });
}
function setChFilter(el, filter){
  _chFilter=filter;
  document.querySelectorAll('#page-comm .ch-filter').forEach(function(b){ b.classList.remove('active'); });
  el.classList.add('active');
  renderChannels();
}
var _currentChId=null;
function openChannelModal(id){
  _chQrSeq++; // 打开新弹窗：终止上一个渠道残留的 QR 轮询链
  _currentChId=id;
  var def=_chState.defs[id];
  var c=_chState.channels[id]||{};
  if(!def) return;
  var m=document.getElementById('channelModal'); if(!m) return;
  if (m.parentElement !== document.body) document.body.appendChild(m);
  m.style.display='flex';
  document.getElementById('chModalTitle').textContent='配置 '+def.name;
  var html='';
  (def.fields||[]).forEach(function(f){
    if(!f.env) return;
    var val=(c.credentials||[]).filter(function(x){ return x.env===f.env; })[0];
    var cur=val?val.value:'';
    html+='<div class="field"><label>'+esc(f.label)+(f.secret?'（保密）':'')+'</label><input type="'+(f.secret?'password':'text')+'" id="chf_'+esc(f.env)+'" value="'+esc(cur)+'" placeholder="'+esc(f.placeholder||'')+'"></div>';
  });
  (def.toggles||[]).forEach(function(t){
    var cur=(c.config && (c.config[t.path]===true||c.config[t.path]==='true'))?true:false;
    html+='<div class="toggle-row"><label class="toggle '+(cur?'on':'')+'" id="cht_'+esc(t.path)+'" onclick="chToggle(\''+esc(t.path)+'\')"><span class="toggle-switch"></span></label><span class="toggle-lbl">'+esc(t.label)+'</span></div>';
  });
  (def.behavior||[]).forEach(function(b){
    var bid='chb_'+b.path.replace(/\./g,'_');
    var cur=(c.config && c.config[b.path]!=null)?String(c.config[b.path]):'';
    html+='<div class="field"><label>'+esc(b.label)+'</label><input type="'+(b.type==='password'?'password':'text')+'" id="'+bid+'" value="'+esc(cur)+'" placeholder="'+esc(b.placeholder||'')+'"></div>';
  });
  if(def.note && (!def.fields||!def.fields.length) && (!def.toggles||!def.toggles.length)){
    html+='<div class="conn-hint">'+esc(def.note)+'</div>';
  }
  // Octop 风格通用行为开关（显示思考过程 / 工具调用提示）
  var behaviorToggles=[
    {key:'show_thinking', label:'显示思考过程'},
    {key:'show_tool_hints', label:'显示工具调用提示'}
  ];
  behaviorToggles.forEach(function(bt){
    var cur=(c.config && (c.config[bt.key]===true||c.config[bt.key]==='true'))?true:false;
    html+='<div class="toggle-row"><label class="toggle '+(cur?'on':'')+'" id="cht_'+esc(bt.key)+'" onclick="chToggle(\''+esc(bt.key)+'\')"><span class="toggle-switch"></span></label><span class="toggle-lbl">'+esc(bt.label)+'</span></div>';
  });
  // ── Octop 风格增强配置：绑定角色 / 模型 / 技能 ──
  html += '<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">';
  html += '<div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--accent)">🎭 角色与能力配置</div>';
  // 绑定 Profile：按 id 去重（防同一角色重复出现），打开弹窗时异步刷新一次
  // 保证新建的 Agent（如预设模板创建的 coder/fnos_operator）能出现在下拉里
  var curProfile = (c.config && c.config.profile) || 'default';
  var profList = (_profiles.length ? _profiles : [{id:'default',name:'默认助手'}]);
  var seenProf = {}; profList = profList.filter(function(p){ if(seenProf[p.id]) return false; seenProf[p.id]=true; return true; });
  if(!profList.some(function(p){ return p.id==='default'; })) profList.unshift({id:'default',name:'默认助手',emoji:'🤖'});
  html += '<div class="field"><label>绑定角色 (Profile)</label><select id="ch_profile" style="width:100%;padding:8px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border)">';
  profList.forEach(function(p){
    html += '<option value="'+esc(p.id)+'"'+(curProfile===p.id?' selected':'')+'>'+esc(p.emoji||'')+' '+esc(p.name||p.id)+'</option>';
  });
  html += '</select><div class="conn-hint" style="font-size:11px;margin-top:4px">该通道收到的消息将使用此角色的系统提示和配置</div></div>';
  // 异步刷新 profiles 并重建下拉（保留当前选中值，去重）
  apiGet('/api/profiles').then(function(res){
    if(res && res.ok && res.profiles){
      _profiles = res.profiles; _profilesLoaded = true;
      renderPersonas(); renderPresetAgents();
      var sel = document.getElementById('ch_profile');
      if(!sel) return;
      var keep = sel.value || curProfile;
      var pl = res.profiles.length ? res.profiles : [{id:'default',name:'默认助手'}];
      var sp = {}; pl = pl.filter(function(p){ if(sp[p.id]) return false; sp[p.id]=true; return true; });
      if(!pl.some(function(p){ return p.id==='default'; })) pl.unshift({id:'default',name:'默认助手',emoji:'🤖'});
      sel.innerHTML = pl.map(function(p){ return '<option value="'+esc(p.id)+'">'+esc(p.emoji||'')+' '+esc(p.name||p.id)+'</option>'; }).join('');
      sel.value = pl.some(function(p){ return p.id===keep; }) ? keep : 'default';
    }
  }).catch(function(){});
  // 模型选择
  var curModel = (c.config && c.config.model) || '';
  html += '<div class="field"><label>模型选择（留空=跟随角色配置）</label><select id="ch_model" style="width:100%;padding:8px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border)">'+buildModelOptionsHtml(curModel, '跟随角色配置')+'</select></div>';
  // 技能多选
  var curSkills = (c.config && c.config.skills) || [];
  if(typeof curSkills === 'string') curSkills = curSkills ? curSkills.split(',') : [];
  html += '<div class="field"><label>启用技能（多选，留空=全部）</label><div id="ch_skills_wrap" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">';
  var knownSkills = ['web_search','code_execution','file_manager','terminal','browser','vision','memory','delegation'];
  knownSkills.forEach(function(sk){
    var checked = curSkills.indexOf(sk) >= 0;
    html += '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:4px 8px;border-radius:4px;background:var(--card);border:1px solid var(--border);cursor:pointer"><input type="checkbox" class="ch-skill-cb" value="'+sk+'"'+(checked?' checked':'')+' style="accent-color:var(--accent)">'+sk+'</label>';
  });
  html += '</div></div>';
  // 系统提示覆盖
  var curSysPrompt = (c.config && c.config.system_prompt) || '';
  html += '<div class="field"><label>系统提示覆盖（可选，优先级高于角色 SOUL.md）</label><textarea id="ch_system_prompt" rows="3" placeholder="留空则使用绑定角色的 SOUL.md" style="width:100%;padding:8px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border);resize:vertical">'+esc(curSysPrompt)+'</textarea></div>';
  html += '</div>';
  // 二维码登录类渠道：不直接弹出二维码，改为「扫码 / 手动输入」选择视图
  if(def.qrLogin){
    var qrFn = id==='telegram' ? 'chStartTelegramQr()' : (id==='whatsapp' ? 'chStartWhatsAppQr()' : (id==='weixin' ? 'chStartWeixinQr()' : (id==='wecom' ? 'chStartWecomQr()' : '')));
    var choice = '<div class="qr-choice">'+
      '<div class="conn-hint" style="margin-bottom:12px">该渠道支持扫码登录或手动填写 Token，请选择一种方式：</div>'+
      '<div class="qr-choice-row">'+
        '<button class="qr-choice-btn" onclick="'+qrFn+'"><div class="qr-choice-ico">📷</div><div><div class="qr-choice-t">扫码登录 / 创建</div><div class="qr-choice-s">用 App 扫码，自动获取凭证</div></div></button>'+
        '<button class="qr-choice-btn" onclick="chShowManualFields()"><div class="qr-choice-ico">🔑</div><div><div class="qr-choice-t">手动输入 Token</div><div class="qr-choice-s">粘贴 Bot Token / 凭证</div></div></button>'+
      '</div>'+
      '<div id="chManualWrap" style="display:none">'+html+'</div>'+
      '</div>';
    document.getElementById('chModalBody').innerHTML=choice;
  } else {
    document.getElementById('chModalBody').innerHTML=html;
  }
  var foot=document.getElementById('chModalFoot');
  var hasConfig = !!(c && (c.configured || (c.credentials||[]).some(function(x){ return x.value; })));
  if(foot) foot.innerHTML='<button class="ov-actbtn danger" id="chClearBtn" onclick="clearChannel()" style="'+(hasConfig?'':'display:none')+'">清空配置</button><button class="ov-actbtn" onclick="testChannel()">测试</button><button class="ov-actbtn start" onclick="saveChannel()">保存</button>';
}
function clearChannel(){
  var id=_currentChId; var def=_chState.defs[id]; if(!id||!def) return;
  if(!confirm('确定清空「'+def.name+'」的全部配置？\n\n将删除已保存的凭证、账号信息和通道设置（含角色绑定、模型、技能、系统提示），网关将自动重启。\n清空后可重新扫码或手动配置。')) return;
  apiPost('/api/channels/'+id+'/clear', {}).then(function(r){
    if(r && r.error){ toast('清空失败：'+r.error); return; }
    apiGet('/api/channels').then(function(res2){
      _chState.channels = (res2 && res2.channels) || _chState.channels;
      renderChannels(); closeChannelModal();
      toast('已清空 '+def.name+' 配置，网关正在重启生效。');
    });
  }).catch(function(e){ toast('清空失败：'+e.message); });
}
function chShowManualFields(){
  var wrap=document.getElementById('chManualWrap'); if(wrap) wrap.style.display='block';
  var row=document.querySelector('#chModalBody .qr-choice-row'); if(row) row.style.display='none';
  var hint=document.querySelector('#chModalBody .qr-choice > .conn-hint'); if(hint) hint.style.display='none';
}
function chToggle(path){ var el=document.getElementById('cht_'+path); if(el) el.classList.toggle('on'); }
function closeChannelModal(){ _chQrSeq++; var m=document.getElementById('channelModal'); if(m) m.style.display='none'; _currentChId=null; }
function testChannel(){
  var id=_currentChId; if(!id){ toast('请先打开一个渠道'); return; }
  var def=_chState.defs[id]; if(!def){ toast('无渠道定义'); return; }
  var credentials={};
  (def.fields||[]).forEach(function(f){ if(!f.env) return; var el=document.getElementById('chf_'+f.env); credentials[f.env]=el?el.value:''; });
  var toggles={};
  (def.toggles||[]).forEach(function(t){ var el=document.getElementById('cht_'+t.path); toggles[t.path]=!!(el&&el.classList.contains('on')); });
  var config={};
  (def.behavior||[]).forEach(function(b){ var bid='chb_'+b.path.replace(/\./g,'_'); var el=document.getElementById(bid); var v=el?el.value:''; if(v&&v.trim()!=='') config[b.path]=b.list?v.split(',').map(function(s){return s.trim();}).filter(Boolean):v.trim(); });
  ['show_thinking','show_tool_hints'].forEach(function(key){ var el=document.getElementById('cht_'+key); config[key]=!!(el&&el.classList.contains('on')); });
  var payload={ kind:id, config:config, credentials:credentials, toggles:toggles };
  toast('正在测试 '+def.name+' 连接…');
  apiPost('/api/channels/'+id+'/test', payload).then(function(r){
    if(r && r.error){
      if(/404/.test(r.error)){ toast('该渠道暂不支持在线测试，保存后重启网关即可生效'); }
      else { toast('连接失败：'+r.error); }
      return;
    }
    toast('连接正常：'+(r&&r.message? r.message : def.name+' 配置有效'));
  });
}
function saveChannel(){
  var id=_currentChId; var def=_chState.defs[id]; if(!def) return;
  var credentials={};
  (def.fields||[]).forEach(function(f){ if(!f.env) return; var el=document.getElementById('chf_'+f.env); credentials[f.env]=el?el.value:''; });
  var toggles={};
  (def.toggles||[]).forEach(function(t){ var el=document.getElementById('cht_'+t.path); toggles[t.path]=!!(el&&el.classList.contains('on')); });
  var config={};
  (def.behavior||[]).forEach(function(b){ var bid='chb_'+b.path.replace(/\./g,'_'); var el=document.getElementById(bid); var v=el?el.value:''; if(v&&v.trim()!=='') config[b.path]=b.list?v.split(',').map(function(s){return s.trim();}).filter(Boolean):v.trim(); });
  // Octop 风格通用行为开关
  ['show_thinking','show_tool_hints'].forEach(function(key){ var el=document.getElementById('cht_'+key); config[key]=!!(el&&el.classList.contains('on')); });
  // Octop 增强：角色/模型/技能/系统提示
  var chProfile=document.getElementById('ch_profile'); if(chProfile) config.profile=chProfile.value;
  var chModel=document.getElementById('ch_model'); if(chModel&&chModel.value.trim()) config.model=chModel.value.trim();
  var skillCbs=document.querySelectorAll('.ch-skill-cb:checked'); if(skillCbs.length) config.skills=Array.from(skillCbs).map(function(cb){ return cb.value; });
  var chSysPrompt=document.getElementById('ch_system_prompt'); if(chSysPrompt&&chSysPrompt.value.trim()) config.system_prompt=chSysPrompt.value.trim();
  apiPost('/api/channels/'+id, { credentials:credentials, toggles:toggles, config:config }).then(function(r){
    if(r && r.error){ toast('保存失败：'+r.error); return; }
    apiGet('/api/channels').then(function(res2){
      _chState.channels = (res2 && res2.channels) || _chState.channels;
      renderChannels(); closeChannelModal();
      toast('已保存 '+def.name+' 配置，网关正在重启生效。');
    });
  }).catch(function(e){ toast('保存失败：'+e.message); });
}
/* 渠道二维码（使用 window.QRCode） */
/* 用 Node `qrcode` 库（window.QRCode.toCanvas）把文本画到 canvas 元素上。
   注意：打包内置的是 node-qrcode，不是 davidshimjs/qrcodejs，没有 `new QRCode(el,{text})` 构造器，
   必须用 QRCode.toCanvas(canvasEl, text, opts, cb)。 */
function drawQR(canvasEl, text){
  return new Promise(function(resolve){
    try {
      if(window.QRCode && typeof window.QRCode.toCanvas === 'function'){
        window.QRCode.toCanvas(canvasEl, String(text||''), { errorCorrectionLevel:'M', margin:1, width:220, color:{ dark:'#000000', light:'#ffffff' } }, function(err){ resolve(!err); });
        return;
      }
    } catch(e){}
    resolve(false);
  });
}
/* 把二维码渲染进 modal 中的 canvas；若库不可用则退化为可复制的链接，避免空白 */
function chRenderQr(deep, canvasId){
  var cv=document.getElementById(canvasId);
  if(!cv) return;
  if(!deep){ var w0=cv.parentNode; if(w0) w0.innerHTML='<div class="conn-hint" style="color:var(--red)">无法生成二维码</div>'; return; }
  drawQR(cv, deep).then(function(ok){
    if(!ok){
      var wrap=cv.parentNode;
      if(wrap){ wrap.innerHTML='<div class="conn-hint" style="color:var(--red)">当前环境无法渲染二维码，请复制以下链接在手机浏览器打开完成授权：</div><div style="word-break:break-all;font-size:12px;background:#f3f4f6;padding:8px;border-radius:var(--radius-sm);margin-top:6px">'+esc(deep)+'</div>'; }
    }
  });
}
function chShowQrSuccess(name){
  var body=document.getElementById('chModalBody'); var foot=document.getElementById('chModalFoot');
  if(foot) foot.innerHTML='';
  if(body) body.innerHTML='<div style="text-align:center;padding:18px 8px"><div style="font-size:42px;line-height:1">✅</div><div style="font-weight:600;margin-top:8px">'+esc(name)+' 已成功关联</div><div class="conn-hint" style="margin-top:8px">凭证已写入本机，网关正在自动重启生效（约 10 秒后可用）。</div><button class="action primary" style="margin-top:14px" onclick="closeChannelModal()">完成</button></div>';
}
function chStartTelegramQr(){
  var seq=++_chQrSeq;
  var body=document.getElementById('chModalBody'); body.innerHTML='<div class="conn-hint">正在生成 Telegram 配对二维码…</div>';
  apiGet('/api/channels/telegram/qr').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error) throw new Error(res&&res.error||'获取二维码失败');
    var deep=res.qr_payload||res.deep_link||'';
    if(!deep){ body.innerHTML='<div class="conn-hint" style="color:var(--red)">无法生成二维码</div>'; return; }
    body.innerHTML='<div class="conn-hint">用 Telegram 扫描下方二维码创建机器人。</div><div style="display:flex;justify-content:center;padding:12px"><canvas id="tgQR" width="220" height="220" style="width:220px;height:220px;background:#fff;border-radius:var(--radius-md)"></canvas></div><div id="tgQrStatus" style="text-align:center;font-size:13px;color:var(--text3)">等待扫码创建…</div><div id="tgAllowWrap" style="display:none;margin-top:12px"><input id="tgAllowed" type="text" placeholder="允许的 Telegram 用户 ID（逗号分隔）" style="width:100%"></div>';
    chRenderQr(deep, 'tgQR');
    chPollTelegramQr(res.pairing_id, seq);
  }).catch(function(e){ if(seq!==_chQrSeq) return; body.innerHTML='<div class="conn-hint" style="color:var(--red)">无法获取二维码：'+(e.message||e)+'</div>'; });
}
function chPollTelegramQr(pid, seq){
  if(seq===undefined) seq=_chQrSeq;
  api('/api/channels/telegram/qr/status?pairing_id='+encodeURIComponent(pid),'GET').then(function(res){
    if(seq!==_chQrSeq) return;
    var stEl=document.getElementById('tgQrStatus');
    if(!res || res.error){ if(stEl) stEl.textContent=(res&&res.error)||'轮询失败'; return; }
    var st=res.status;
    if(st==='waiting'){ if(stEl) stEl.textContent='等待在 Telegram 中点击「Create Bot」…'; setTimeout(function(){ if(seq===_chQrSeq) chPollTelegramQr(pid, seq); }, 2500); }
    else if(st==='ready'){ if(stEl) stEl.textContent='✅ 机器人已创建：'+(res.bot_username||'')+'，请填写允许的用户 ID 后点击「完成」。'; var w=document.getElementById('tgAllowWrap'); if(w) w.style.display='block'; var inp=document.getElementById('tgAllowed'); if(inp&&res.owner_user_id) inp.value=res.owner_user_id; var foot=document.getElementById('chModalFoot'); if(foot) foot.innerHTML='<div style="margin-right:auto;font-size:11px;color:var(--text3)">凭证仅保存在本机</div><button class="action primary" onclick="chApplyTelegramQr(\''+esc(pid)+'\')">完成</button>'; }
    else if(st==='confirmed'){ chShowQrSuccess('Telegram'); }
  }).catch(function(e){ var stEl=document.getElementById('tgQrStatus'); if(stEl) stEl.textContent='轮询出错：'+(e.message||e); });
}
function chApplyTelegramQr(pid){
  var el=document.getElementById('tgAllowed'); var allowed=el?el.value:'';
  apiPost('/api/channels/telegram/qr/apply', { pairing_id:pid, allowed_user_ids:allowed }).then(function(res){
    if(res && res.error) throw new Error(res.error);
    apiGet('/api/channels').then(function(r2){ _chState.channels=(r2&&r2.channels)||_chState.channels; renderChannels(); chShowQrSuccess('Telegram'); });
  }).catch(function(e){ alert('保存失败：'+(e.message||e)); });
}
function chStartWhatsAppQr(){
  var seq=++_chQrSeq;
  var body=document.getElementById('chModalBody');
  body.innerHTML='<div class="conn-hint">WhatsApp 通过本地桥接扫码配对，消息在本地处理。</div><div id="waQrZone" style="text-align:center;margin-top:8px"><div class="conn-hint">正在启动桥接并生成二维码…</div></div>';
  api('/api/channels/whatsapp/qr?mode=self-chat','GET').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error) throw new Error(res.error||'启动失败');
    if(res.status==='connected'){ chApplyWhatsAppQr(res.pairing_id); return; }
    var waDeep=res.qr_payload||res.deep_link||'';
    if(!waDeep){ body.innerHTML='<div class="conn-hint" style="color:var(--red)">二维码生成失败</div>'; return; }
    body.innerHTML='<div class="conn-hint">用 WhatsApp 扫描上方二维码 → 设置 → 关联设备。</div><div style="display:flex;justify-content:center;padding:8px"><canvas id="waQR" width="240" height="240" style="width:240px;height:240px;background:#fff;border-radius:var(--radius-md)"></canvas></div><div id="waQrStatus" style="font-size:13px;color:var(--text3)">等待在 WhatsApp 中确认…</div>';
    chRenderQr(waDeep, 'waQR');
    chPollWhatsAppQr(res.pairing_id, seq);
  }).catch(function(e){ if(seq!==_chQrSeq) return; body.innerHTML='<div class="conn-hint" style="color:var(--red)">启动失败：'+(e.message||e)+'</div>'; });
}
function chPollWhatsAppQr(pid, seq){
  if(seq===undefined) seq=_chQrSeq;
  api('/api/channels/whatsapp/qr/status?pairing_id='+encodeURIComponent(pid),'GET').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error){ var z=document.getElementById('waQrZone'); if(z) z.innerHTML='<div class="conn-hint" style="color:var(--red)">'+(res&&res.error||'配对失败')+'</div>'; return; }
    var st=res.status; var stEl=document.getElementById('waQrStatus');
    if(st==='starting'||st==='waiting'){ if(stEl) stEl.textContent=(st==='starting')?'正在等待二维码…':'等待在 WhatsApp 中确认…'; var newQr=res.qr_payload||res.deep_link||''; if(newQr&&st==='waiting'){ var c=document.getElementById('waQR'); if(c) drawQR(c, newQr); } setTimeout(function(){ if(seq===_chQrSeq) chPollWhatsAppQr(pid, seq); }, 2000); }
    else if(st==='connected'){ if(stEl) stEl.textContent='✅ 已连接：'+(res.account_name||'')+'，正在保存…'; chApplyWhatsAppQr(pid); }
    else if(st==='expired'||st==='error'){ var z2=document.getElementById('waQrZone'); if(z2) z2.innerHTML='<div class="conn-hint" style="color:var(--red)">'+(res.error||'配对失败或二维码已过期。')+'</div><button class="action" style="margin-top:10px" onclick="chStartWhatsAppQr()">重新获取二维码</button>'; }
  }).catch(function(e){ var stEl=document.getElementById('waQrStatus'); if(stEl) stEl.textContent='轮询出错：'+(e.message||e); });
}
function chApplyWhatsAppQr(pid){
  apiPost('/api/channels/whatsapp/qr/apply', { pairing_id:pid, allowed_users:'' }).then(function(res){
    if(res && res.error) throw new Error(res.error);
    apiGet('/api/channels').then(function(r2){ _chState.channels=(r2&&r2.channels)||_chState.channels; renderChannels(); chShowQrSuccess('WhatsApp'); });
  }).catch(function(e){ alert('保存失败：'+(e.message||e)); });
}
function chStartWeixinQr(){
  var seq=++_chQrSeq;
  var body=document.getElementById('chModalBody'); body.innerHTML='<div class="conn-hint">正在获取微信登录二维码…</div>';
  apiGet('/api/channels/weixin/qr').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error) throw new Error(res.error||'获取二维码失败');
    var deep=res.qrcode_url||res.qrcode_img||'';
    if(!deep && res.qrcode) deep='https://ilinkai.weixin.qq.com/ilink/bot/scan?qrcode='+encodeURIComponent(res.qrcode);
    if(!deep){ body.innerHTML='<div class="conn-hint" style="color:var(--red)">二维码生成失败</div>'; return; }
    body.innerHTML='<div class="conn-hint">请用微信扫描下方二维码完成登录（腾讯 iLink 官方接口）。</div><div style="display:flex;justify-content:center;padding:12px"><canvas id="wxQR" width="200" height="200" style="width:200px;height:200px;background:#fff;border-radius:var(--radius-md)"></canvas></div><div id="wxQrStatus" style="text-align:center;font-size:13px;color:var(--text3)">等待扫码…</div>';
    chRenderQr(deep, 'wxQR');
    chPollWeixinQr(res.qrcode, seq);
  }).catch(function(e){ if(seq!==_chQrSeq) return; body.innerHTML='<div class="conn-hint" style="color:var(--red)">无法获取二维码：'+(e.message||e)+'</div>'; });
}
function chPollWeixinQr(qrcode, seq){
  if(seq===undefined) seq=_chQrSeq;
  api('/api/channels/weixin/qr/status?qrcode='+encodeURIComponent(qrcode),'GET').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error) throw new Error(res.error||'poll failed');
    var st=res.status;
    var stEl=document.getElementById('wxQrStatus');
    if(st==='wait'){ setTimeout(function(){ if(seq===_chQrSeq) chPollWeixinQr(qrcode, seq); }, 3000); }
    else if(st==='scaned'){ if(stEl) stEl.textContent='已扫码，请在微信中确认登录…'; setTimeout(function(){ if(seq===_chQrSeq) chPollWeixinQr(qrcode, seq); }, 3000); }
    else if(st==='expired'){ var body=document.getElementById('chModalBody'); if(body) body.innerHTML='<div class="conn-hint">二维码已过期，请重新获取。</div><button class="action" style="margin-top:10px" onclick="chStartWeixinQr()">重新获取二维码</button>'; }
    else if(st==='confirmed'){ if(stEl) stEl.textContent='登录成功，正在保存凭证…'; apiPost('/api/channels/weixin',{ credentials:{ WEIXIN_TOKEN:res.token||'', WEIXIN_ACCOUNT_ID:res.account_id||'', WEIXIN_BASE_URL:res.base_url||'' } }).then(function(){ apiGet('/api/channels').then(function(r2){ _chState.channels=(r2&&r2.channels)||_chState.channels; renderChannels(); chShowQrSuccess('微信'); }); }); }
  }).catch(function(e){ var stEl=document.getElementById('wxQrStatus'); if(stEl) stEl.textContent='轮询出错：'+(e.message||e); });
}
/* 企业微信扫码登录：腾讯官方 AI 机器人扫码接口（与 Octop 一致），
   无需预先填写 Corp ID——扫码授权后由服务端获取 bot_id + secret 自动保存。 */
function chStartWecomQr(){
  var seq=++_chQrSeq;
  var body=document.getElementById('chModalBody'); body.innerHTML='<div class="conn-hint">正在生成企业微信授权二维码…</div>';
  apiGet('/api/channels/wecom/qr').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error) throw new Error(res.error||'获取二维码失败');
    var authUrl=res.qr_payload||res.qr_url||res.deep_link||'';
    if(!authUrl){ body.innerHTML='<div class="conn-hint" style="color:var(--red)">无法生成二维码</div>'; return; }
    body.innerHTML='<div class="conn-hint">用企业微信「扫一扫」扫描下方二维码，在手机端确认创建 AI 机器人。</div><div style="display:flex;justify-content:center;padding:12px"><canvas id="wcQR" width="220" height="220" style="width:220px;height:220px;background:#fff;border-radius:var(--radius-md)"></canvas></div><div id="wcQrStatus" style="text-align:center;font-size:13px;color:var(--text3)">等待扫码授权…</div>';
    chRenderQr(authUrl, 'wcQR');
    chPollWecomQr(res.scode, seq);
  }).catch(function(e){ if(seq!==_chQrSeq) return; body.innerHTML='<div class="conn-hint" style="color:var(--red)">无法获取二维码：'+(e.message||e)+'</div>'; });
}
function chPollWecomQr(scode, seq){
  if(seq===undefined) seq=_chQrSeq;
  api('/api/channels/wecom/qr/status?scode='+encodeURIComponent(scode),'GET').then(function(res){
    if(seq!==_chQrSeq) return;
    var stEl=document.getElementById('wcQrStatus');
    if(!res || res.error){ if(stEl) stEl.textContent='轮询失败：'+((res&&res.error)||'未知错误'); return; }
    var st=res.status;
    if(st==='waiting'){ if(stEl) stEl.textContent='等待扫码确认…'; setTimeout(function(){ if(seq===_chQrSeq) chPollWecomQr(scode, seq); }, 3000); }
    else if(st==='ready'){ if(stEl) stEl.textContent='✅ 授权成功：Bot '+(res.bot_id||'')+'，点击「完成」启用。'; var foot=document.getElementById('chModalFoot'); if(foot) foot.innerHTML='<div style="margin-right:auto;font-size:11px;color:var(--text3)">凭证仅保存在本机</div><button class="action primary" onclick="chApplyWecomQr(\''+esc(scode)+'\')">完成</button>'; }
    else if(st==='expired'||st==='error'){ var z=document.getElementById('chModalBody'); if(z) z.innerHTML='<div class="conn-hint" style="color:var(--red)">'+(res.error||'扫码失败或二维码已过期。')+'</div><button class="action" style="margin-top:10px" onclick="chStartWecomQr()">重新获取二维码</button>'; }
  }).catch(function(e){ if(seq!==_chQrSeq) return; var stEl=document.getElementById('wcQrStatus'); if(stEl) stEl.textContent='轮询出错：'+(e.message||e); });
}
function chApplyWecomQr(scode){
  apiPost('/api/channels/wecom/qr/apply', { scode: scode }).then(function(res){
    if(res && res.error) throw new Error(res.error);
    apiGet('/api/channels').then(function(r2){ _chState.channels=(r2&&r2.channels)||_chState.channels; renderChannels(); chShowQrSuccess('企业微信'); });
  }).catch(function(e){ alert('保存失败：'+(e.message||e)); });
}
/* ============================ 更新 ============================ */
// 注意：btn 只接受显式传入的 event；切勿读全局 event —— switchPage('updates') 自动调用本函数时
// 全局 event 仍是侧边栏「更新」导航按钮的点击事件，event.target 会命中导航按钮，
// textContent 会抹掉导航按钮里的 SVG 图标（更新页丢图标 bug 根因）。
function _resolveCheckBtn(evt){
  var t = evt && evt.currentTarget;
  return (t && t.tagName === 'BUTTON') ? t : null;
}
function checkHermesUpdate(evt){
  var btn=_resolveCheckBtn(evt); if(btn){btn.disabled=true;btn.textContent='检查中…';}
  apiGet('/api/hermes/update/check').then(function(data){
    if(!data || data.error){ var b=document.getElementById('hermesUpdateBtn'); if(b) b.style.display='none'; toast(data&&data.error?'检查失败：'+data.error:'检查 Hermes 更新失败'); return; }
    if(data.date) window.__hermesDate=data.date;
    var lat=document.getElementById('hermesLatest');
    if(lat){ if(data.updateAvailable){ lat.textContent=data.latest||'未知'; var b2=document.getElementById('hermesUpdateBtn'); if(b2) b2.style.display='inline-flex'; toast('发现新版本：'+data.latest); } else { lat.textContent='已是最新'; var b3=document.getElementById('hermesUpdateBtn'); if(b3) b3.style.display='none'; toast('Hermes 核心已是最新'); } }
  }).catch(function(){ toast('检查 Hermes 更新失败'); }).finally(function(){ if(btn){btn.disabled=false;btn.textContent='检查更新';} });
}
function confirmHermesUpdate(){
  if(!confirm('确认更新 Hermes 核心？更新期间服务会短暂中断。')) return;
  apiPost('/api/hermes/update', {}).then(function(data){
    if(data && data.error){ toast('启动更新失败：'+data.error); return; }
    toast('Hermes 更新中…');
    var tries=0;
    (function poll(){
      tries++;
      apiGet('/api/hermes/update/status').then(function(d){
        if(d && d.status==='done'){ toast('Hermes 更新完成，正在重启'); apiPost('/api/restart',{}); var btn=document.getElementById('hermesUpdateBtn'); if(btn) btn.style.display='none'; }
        else if(d && d.status==='error'){ toast('更新失败'); }
        else if(tries<40){ setTimeout(poll, 2000); }
      }).catch(function(){ if(tries<40) setTimeout(poll,2000); });
    })();
  }).catch(function(e){ toast('启动更新失败：'+e.message); });
}
function checkAppUpdate(evt){
  var btn=_resolveCheckBtn(evt); if(btn){btn.disabled=true;btn.textContent='检查中…';}
  apiGet('/api/app/update/check').then(function(data){
    if(!data || data.error){ var b=document.getElementById('appUpdateBtn'); if(b) b.style.display='none'; toast(data&&data.error?'检查失败：'+data.error:'检查应用更新失败'); return; }
    // 缓存更新信息供「完整安装」按钮使用（是否有 fpk 安装包/发布页链接）
    window.__appUpdateInfo={ latest:data.latest||'', html_url:data.html_url||'', download_url:data.download_url||'' };
    var lat=document.getElementById('appLatest');
    if(data.rateLimited){
      // PAT 未配置或 GitHub 限流：显示提示，隐藏更新按钮
      if(lat) lat.textContent=data.hint||'无法检查更新';
      var btn2=document.getElementById('appUpdateBtn'); if(btn2) btn2.style.display='none';
      toast(data.hint||'GitHub API 限流');
      return;
    }
    if(lat){
      if(data.updateAvailable){
        lat.textContent='v'+data.latest;
        var btn3=document.getElementById('appUpdateBtn'); if(btn3) btn3.style.display='inline-flex';
        toast('发现新版本：v'+data.latest+'，可点击「下载安装包」从 GitHub 获取');
      } else {
        lat.textContent='已是最新';
        var btn4=document.getElementById('appUpdateBtn'); if(btn4) btn4.style.display='none';
        toast('Hermes Agent 应用已是最新');
      }
    }
  }).catch(function(){ toast('检查应用更新失败'); }).finally(function(){ if(btn){btn.disabled=false;btn.textContent='检查更新';} });
}
function confirmAppUpdate(){
  // 完整安装：直接打开 GitHub 上最新 .fpk 安装包的下载地址（仓库公开，浏览器可直链下载），
  // 下载完成后由用户在 fnOS「应用中心」手动安装/覆盖完成升级，不做服务端自动替换。
  var info=window.__appUpdateInfo||{};
  if(info.download_url){
    toast('正在打开 GitHub 下载 v'+(info.latest||'最新')+' 安装包 (.fpk)…');
    window.open(info.download_url,'_blank');
  } else {
    toast('未获取到安装包直链，已打开 GitHub 发布页…');
    window.open(info.html_url||'https://github.com/hermes-agent/fnos-hermes-agent/releases/latest','_blank');
  }
}

/* ============================ 设置页 ============================ */
function renderSettings(){
  // data-key 选项：从 _cfg 读取（后端未显式支持时存于 _cfg.chat）
  applySettingsToggles();
}
function applySettingsToggles(){
  // 设置项存于本机 localStorage（后端 config 接口不持久化 chat 段），刷新后仍生效
  var chat = (PV.Store.load().chat) || {};
  document.querySelectorAll('#page-settings .setting-row .toggle').forEach(function(t){
    var key=t.getAttribute('data-key'); if(!key) return;
    var stored = (chat[key]!==undefined) ? !!chat[key] : t.classList.contains('on');
    t.classList.toggle('on', stored);
  });
}
function initSettingsToggles(){
  var local = PV.Store.load(); local.chat = local.chat || {};
  document.querySelectorAll('#page-settings .setting-row .toggle').forEach(function(t){
    var key=t.getAttribute('data-key'); if(!key) return;
    t.addEventListener('click', function(){
      var on=t.classList.toggle('on');
      local.chat[key]=on; PV.Store.save(local);
      _cfg.chat = _cfg.chat || {}; _cfg.chat[key]=on;
      toast(on ? ('已开启：'+key) : ('已关闭：'+key));
    });
  });
  applySettingsToggles();
}

/* ============================ 初始化 ============================ */
document.addEventListener('click', function(e){
  if(popup && !popup.contains(e.target) && !(e.target.closest && e.target.closest('.tool-btn'))) closeMini();
});

/* ============================ 飞牛桌面会话保活 ============================ */
// Hermes 以同源 iframe 嵌入飞牛（fnOS）桌面（经 fnOS gateway 反向代理，带 BASE_PATH 前缀）。
// 用户在 iframe 内的鼠标/键盘操作不会冒泡到飞牛顶层文档的活动监听器，飞牛空闲计时器
// 会误判为「无操作」，超时后把整个桌面登出（弹「您已被登出」）。
// 这里在嵌入环境下周期性向顶层文档派发合成 mousemove 事件，重置飞牛空闲计时器，
// 恢复「打开 Hermes 聊天界面期间飞牛不被登出」的旧版行为。独立端口（顶层窗口）访问时自动跳过。
function setupFnosKeepAlive(){
  try {
    if(window.self === window.top) return;            // 独立窗口访问，无需保活
    var topWin = window.top;
    var topDoc = topWin && topWin.document;
    if(!topDoc) return;
    try { void topDoc.body; } catch(e){ return; }     // 跨域（不同源）无法访问顶层文档，跳过
    // 向顶层文档/窗口派发「无害活动事件」（mousemove/pointermove），重置飞牛桌面空闲计时器。
    // 只用鼠标移动类事件，避免 keydown/wheel 误触飞牛快捷键或滚动桌面。
    var fire = function(){
      try {
        if(document.hidden) return;                   // 切到其他飞牛应用时停止保活，交还飞牛空闲计时
        ['mousemove','pointermove'].forEach(function(t){
          try { topDoc.dispatchEvent(new topWin.MouseEvent(t, { bubbles:true, cancelable:true, view:topWin })); } catch(e){}
          try { topWin.dispatchEvent(new topWin.MouseEvent(t, { bubbles:true, cancelable:true, view:topWin })); } catch(e){}
        });
      } catch(e){}
    };
    setInterval(fire, 30000);                         // 周期保活，远短于飞牛空闲超时
    setTimeout(fire, 1500);                           // 载入后先打一次，避免首分钟内被判定空闲
    // 用户在 iframe 内真实操作鼠标时，同步向顶层文档转发活动事件，使活跃期间持续重置飞牛空闲计时。
    ['mousemove','pointermove','mousedown'].forEach(function(t){
      try {
        document.addEventListener(t, function(){
          try { if(!document.hidden) topDoc.dispatchEvent(new topWin.MouseEvent(t, { bubbles:true, cancelable:true, view:topWin })); } catch(e){}
        }, { passive:true, capture:true });
      } catch(e){}
    });
  } catch(e){}
}

document.addEventListener('DOMContentLoaded', function(){
  BASE = _resolveBase();
  setTheme(localStorage.getItem('fnos-theme-mode')||'auto');
  initSettingsToggles();
  setupFnosKeepAlive();
  var inp=document.getElementById('chatInput');
  if(inp){ inp.addEventListener('input', function(){ autoResize(this); }); autoResize(inp); }
  switchPage('chat');
  // 专家库改为按需懒加载：进入「扩展→专家库/专家团」或打开专家胶囊时由 ensurePersonasLibrary 注入（版本号缓存键，不再启动即下载 3.4MB）
  window.__personasOpenMini = function(){
    if(activePanel==='expert'){ var b=document.getElementById('btnExpert'); if(b){ closeMini(); openMini(b,'expert'); } }
    var ec=document.getElementById('expCount'); if(ec) ec.textContent='共 '+expertsList().length+' 位专家';
  };
  // 拉取 token 后加载所有真实数据
  fetchToken().then(function(){
    // 并行发起：profiles / 通道会话不依赖 _cfg，与 loadConfig 同时进行，避免串行请求链拖慢首屏
    fetchProfiles();  // 初始化加载 profiles（智能体/角色）
    fetchChannelSessions();  // 初始化加载通道会话（微信等）
    setInterval(fetchChannelSessions, 30000);  // 每30秒刷新通道会话
    loadConfig().then(function(){
      renderProviders();
      renderExtensions();
      renderConnectors();
      renderChannels();
      renderWorkflowBar();
      renderTeamBar();
      // 团队模式恢复：刷新页面后保持 team 分组为当前活动分组，新会话自动归入
      if (_cfg.extensions.team_enabled && _cfg.extensions.team && _cfg.extensions.team.length) {
        ensureAgent('team', { name: _cfg.extensions.team_name || '我的团队', icon: '👥' });
        currentAgent = 'team';
        localStorage.setItem('hermes_rail_open_team', 'true');
      }
      // 恢复上次选择的模型按钮状态（per-session）
      var _initModel = _getSessionModel();
      if(_initModel){
        var mName = (typeof _initModel==='object'&&_initModel.model) ? _initModel.model : _initModel;
        var bm=document.getElementById('btnModel');
        if(bm){
          bm.setAttribute('data-tip','模型: '+mName); bm.classList.add('active');
          var badge=document.createElement('span');
          badge.className='model-badge';
          badge.textContent=mName.length>8?mName.slice(0,8)+'…':mName;
          bm.appendChild(badge);
        }
      }
      // 必须在配置（含 agents 分组与 session→分组映射）恢复之后再加载会话并渲染侧栏，
      // 否则 loadSessions 的 renderRail 会先用空映射把所有会话归入「默认主力助手」分组
      loadSessions();
    }).catch(function(){ loadSessions(); });
    renderOverview();
    tickStatus();
    setInterval(tickStatus, 3000);   // 轻量周期轮询：状态变化（重启/启动/停止后）自动反映，无需阻塞等待
  }).catch(function(){
    toast('无法连接后端，已进入本地预览（数据不可用）。');
    renderRail();
  });
  // 滚动到底部按钮（Issue #10）
  var cb=document.getElementById('chatBody');
  if(cb){
    cb.addEventListener('scroll', function(){
      var btn=document.getElementById('scrollBottomBtn');
      if(!btn) return;
      if(cb.scrollTop + cb.clientHeight < cb.scrollHeight - 50){ btn.style.display='flex'; }
      else { btn.style.display='none'; }
    });
  }
});

