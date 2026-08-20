/**
 * Hermes Desktop → Web shim
 *
 * 将 Electron 桌面端的 window.hermesDesktop 桥替换为纯浏览器实现:
 * - 核心通信(api / getConnection / getGatewayWsUrl)走同源 monitor 代理 + session token
 * - Electron 特有能力(fs/git/terminal/hud/pet/剪贴板等)降级为空实现
 * - 未定义方法由 Proxy 兜底返回 null,避免 renderer 崩溃
 *
 * 依赖注入:页面由 monitor serve 时注入 window.__HERMES_WEB_CONFIG__:
 *   { base: '/proxy/dashboard', token: '<session-token>', profile?: '<id>' }
 */
(function () {
  "use strict";
  var CONFIG = window.__HERMES_WEB_CONFIG__;
  if (!CONFIG) {
    // 未注入配置时仍安装桥,但 api/连接抛错,避免白屏
    CONFIG = { base: "/proxy/dashboard", token: "", profile: null };
  }
  var base = CONFIG.base.replace(/\/+$/, "");
  var token = CONFIG.token;

  


  function wsUrlFor() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + base + "/api/ws?token=" + encodeURIComponent(token);
  }

  function mkConnection() {
    return {
      baseUrl: base,
      isFullscreen: false,
      mode: "local",
      authMode: "token",
      nativeOverlayWidth: 0,
      token: token,
      wsUrl: wsUrlFor(),
      logs: [],
      source: "env",
      windowButtonPosition: null,
      profile: CONFIG.profile || undefined,
    };
  }

  var core = {
    // ── 版本信息（关于页「版本号」显示；值由 monitor 注入 __HERMES_WEB_CONFIG__）──
    getVersion: function () {
      var cfg = {};
      try { cfg = (typeof window !== "undefined" && window.__HERMES_WEB_CONFIG__) || CONFIG || {}; } catch (e) {}
      return Promise.resolve({
        appVersion: cfg.appVersion || null,
        electronVersion: "",
        nodeVersion: "",
        platform: "web",
        hermesRoot: cfg.hermesRoot || "",
      });
    },
    // ── 核心:JSON REST(经 monitor 同源代理) ──
    api: function (request) {
      var path = request && request.path ? request.path : "";
      var opts = {
        method: request.method || "GET",
        headers: { "X-Hermes-Session-Token": token },
      };
      if (request.body !== undefined && request.body !== null) {
        opts.method = request.method || "POST";
        if (typeof request.body === "string") {
          opts.body = request.body;
          opts.headers["Content-Type"] = request.headers && request.headers["Content-Type"] ? request.headers["Content-Type"] : "text/plain";
        } else {
          opts.body = JSON.stringify(request.body);
          opts.headers["Content-Type"] = "application/json";
        }
      }
      if (request.timeoutMs) {
        try { opts.signal = AbortSignal.timeout(request.timeoutMs); } catch (e) {}
      }
      return fetch(base + path, opts).then(function (res) {
        if (path === "/api/config") {
          return res.clone().json().then(function (d) {
            if (d && typeof d === "object" && (!d.display || !d.display.language)) {
              d = Object.assign({}, d, { display: Object.assign({}, d.display, { language: "zh" }) });
            }
            return d;
          });
        }
        if (!res.ok) {
          if (path === "/api/config") { return { display: { language: "zh" } }; }
          // 会话 404(重装后旧会话 ID 残留):返回空,不报错不刷屏
          if (res.status === 404 && /\/api\/sessions\//.test(path)) {
            return { session: null, messages: [], sessions: [] };
          }
          var err = new Error("HTTP " + res.status + " " + res.statusText);
          err.status = res.status;
          throw err;
        }
        return res.json().catch(function () {
          return path === "/api/config" ? { display: { language: "zh" } } : {};
        });
      });
    },

    // ── 连接 ──
    getConnection: function () { return Promise.resolve(mkConnection()); },
    getConnectionFor: function () { return Promise.resolve(mkConnection()); },
    getGatewayWsUrl: function () { return Promise.resolve({ ok: true, wsUrl: wsUrlFor() }); },
    getGatewayWsUrlFor: function () { return Promise.resolve({ ok: true, wsUrl: wsUrlFor() }); },
    getConnectionConfig: function () {
      return Promise.resolve({
        envOverride: false, mode: "local", profile: CONFIG.profile || null,
        remoteAuthMode: "token", remoteOauthConnected: false, remoteTokenPreview: null,
        remoteTokenSet: false, secureTokenStorage: false, remoteTokenPlainText: false,
        remoteUrl: "", cloudOrg: "", sshHost: "", sshUser: "", sshPort: null,
        sshKeyPath: "", sshRemoteHermesPath: "", sshRemoteProfile: "",
      });
    },
    getProfileRoutes: function () { return Promise.resolve({}); },
    revalidateConnection: function () { return Promise.resolve(mkConnection()); },
    touchBackend: function () { return Promise.resolve({ ok: true }); },
    getAgentRoster: function () { return Promise.resolve([]); },
    getActiveProfile: function () { return Promise.resolve({ profile: CONFIG.profile || null }); },

    // ── 连接配置(web 仅支持当前注入连接) ──
    testConnectionConfig: function (cfg) {
      var u = cfg && cfg.baseUrl ? cfg.baseUrl : base;
      return fetch(u + "/api/health", { headers: { "X-Hermes-Session-Token": token }, signal: AbortSignal.timeout(8000) })
        .then(function (r) { return r.ok ? { reachable: true, authMode: "unknown", latency_ms: 0 } : { reachable: false, authMode: "unknown", error: "HTTP " + r.status }; })
        .catch(function (e) { return { ok: false, error: e.message }; });
    },
    probeConnectionConfig: function () { return Promise.resolve({ reachable: false, authMode: "unknown" }); },
    applyConnectionConfig: function () { return Promise.resolve(mkConnection()); },
    oauthLoginConnectionConfig: function () { return Promise.resolve({ ok: false, error: "web: OAuth login unavailable" }); },
    oauthLogoutConnectionConfig: function () { return Promise.resolve({ ok: true }); },
    saveConnectionConfig: function () { return Promise.resolve({ ok: true }); },
    sshConfigHosts: function () { return Promise.resolve({ hosts: [] }); },

    // ── 浏览器能力 ──
    openExternal: function (url) { window.open(url, "_blank"); return Promise.resolve(); },
    notify: function (payload) {
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification((payload && payload.title) || "Hermes", { body: payload && payload.body });
        }
      } catch (e) {}
      return Promise.resolve(true);
    },
    openSessionWindow: function () { return Promise.resolve(); },
    openSessionInTerminal: function () { return Promise.resolve(); },
    openWindow: function () { return Promise.resolve(); },
    log: function (level, msg) { try { console[level] ? console[level]("[hermes-web]", msg) : console.log("[hermes-web]", msg); } catch (e) {} return Promise.resolve(); },
    writeClipboard: function (text) {
      try { if (navigator.clipboard) navigator.clipboard.writeText(String(text)); } catch (e) {}
      return Promise.resolve();
    },
    getBootProgress: function () { return Promise.resolve({ phase: "ready", progress: 1, label: "" }); },
    emitBootstrapEvent: function () { return Promise.resolve(); },
    continueBootstrapLocal: function () { return Promise.resolve({ ok: true }); },

    // ── 窗口/UI 状态(web 单窗口,返回默认) ──
    lastSessionId: function () { return Promise.resolve(null); },
    lastRoute: function () { return Promise.resolve(null); },
    zoom: {
      get: function () { return Promise.resolve({ percent: 1 }); },
      setPercent: function () { return Promise.resolve(); },
      set: function () { return Promise.resolve(); },
      onChanged: function () { return function () {}; },
    },
    // 错误恢复页的"修复安装":触发 monitor 重启 gateway+dashboard(后端修复)
    // 注意:/api/app/* 是 monitor 级路由,不走 /proxy/dashboard 代理
    repairBootstrap: function () {
      return fetch("/api/app/repair", {
        method: "POST",
        headers: { "X-Monitor-Token": token },
        signal: AbortSignal.timeout(15000),
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          if (d && d.ok) { setTimeout(function () { location.reload(); }, 4000); }
          return d || {};
        })
        .catch(function (e) { return { ok: false, error: e.message }; });
    },
    resetBootstrap: function () { setTimeout(function () { location.reload(); }, 300); return Promise.resolve(); },
    getWindowState: function () { return Promise.resolve({ isFullscreen: false, isMinimized: false, isVisible: true, nativeOverlayWidth: 0, windowButtonPosition: null }); },
    setWindowState: function () { return Promise.resolve(); },
    getUserTheme: function () { return Promise.resolve({}); },
    setUserTheme: function () { return Promise.resolve(); },
    translucency: function () { return Promise.resolve(false); },
    layoutTree: function () { return Promise.resolve(null); },
    userPlacedPanes: function () { return Promise.resolve([]); },
    sessionListDensity: function () { return Promise.resolve(null); },
    pinnedSessions: function () { return Promise.resolve([]); },
    unreadFinishedSessions: function () { return Promise.resolve([]); },
    sidebarGrouping: function () { return Promise.resolve(null); },
    previewTabs: function () { return Promise.resolve([]); },
    composerPopout: function () { return Promise.resolve(); },
    composer: function () { return Promise.resolve(null); },
    inflightTurnJournal: function () { return Promise.resolve({}); },
    json: function () { return Promise.resolve(null); },
    claimAmbientCue: function () { return Promise.resolve(null); },

    // ── 降级:文件/终端/桌面特有(嵌套对象统一走 nested 定义,带嵌套 Proxy) ──
    workspace: function () { return Promise.resolve({ path: "", exists: false }); },
    readFileDataUrl: function () { return Promise.resolve(null); },
    writeTextFile: function () { return Promise.resolve(); },
    trashPath: function () { return Promise.resolve(); },
    watchDirectory: function () { return Promise.resolve(function () {}); },
    gitRoot: function () { return Promise.resolve(null); },
    findInPage: function () { return Promise.resolve(); },
    repo_scan_enabled: function () { return Promise.resolve(false); },
    repo_scan_roots: function () { return Promise.resolve([]); },
    repo_scan_exclude_paths: function () { return Promise.resolve([]); },
  };

  // 万能兜底:既是可调用函数(返回 null),又能任意属性访问(返回新的兜底)。
  // 解决 renderer 对未定义键做 updates.onProgress() 这类调用时的崩溃
  // (未定义键兜底成函数后 .onProgress 为 undefined → "xxx is not a function")。
  function makeFbObj() {
    var o = function () {};
    o.toString = function () { return ""; };
    o[Symbol.toPrimitive] = function () { return ""; };
    o[Symbol.iterator] = function () { return [][Symbol.iterator](); };
    return new Proxy(o, {
      get: function (t, prop) { if (prop in t) return t[prop]; return makeFbObj(); },
      apply: function () { return Promise.resolve(makeFbObj()); },
    });
  }
  function makeFallback() {
    var fn = function () { return Promise.resolve(null); };
    fn.toString = function () { return ""; };
    fn[Symbol.toPrimitive] = function () { return ""; };
    fn[Symbol.iterator] = function () { return [][Symbol.iterator](); };
    return new Proxy(fn, {
      get: function (t, prop) {
        if (prop in t) return t[prop];
        if (typeof prop === "string" && /^on[A-Z]/.test(prop)) {
          return function () { return function () {}; };
        }
        return makeFallback();
      },
      apply: function () { return Promise.resolve(null); },
      construct: function () { return makeFallback(); },
    });
  }

  // 显式定义 renderer 高频访问的嵌套对象(含 updates 复数键,renderer 用
  // hermesDesktop.updates.onProgress/subscribe/check)
  var nested = {
    fs: { readDir: function () { return Promise.resolve([]); }, readFileText: function () { return Promise.resolve(null); }, writeTextFile: function () { return Promise.resolve(); } },
    git: { listBranches: function () { return Promise.resolve([]); } },
    terminal: { list: function () { return Promise.resolve([]); } },
    hud: { open: function () { return Promise.resolve({}); }, close: function () { return Promise.resolve(); }, getState: function () { return Promise.resolve(false); }, setIgnoreMouse: function () { return Promise.resolve(); }, moveBy: function () { return Promise.resolve(); }, setBounds: function () { return Promise.resolve(); }, setVibrancy: function () { return Promise.resolve(false); }, setSession: function () { return Promise.resolve(); }, onChanged: function () { return function () {}; }, onGoto: function () { return function () {}; }, onCursor: function () { return function () {}; } },
    petOverlay: { open: function () { return Promise.resolve({}); }, close: function () { return Promise.resolve(); }, getState: function () { return Promise.resolve(false); }, setBounds: function () { return Promise.resolve(); }, setIgnoreMouse: function () { return Promise.resolve(); }, setFocusable: function () { return Promise.resolve(); }, pushState: function () { return Promise.resolve(); }, onState: function () { return function () {}; }, onControl: function () { return function () {}; } },
    wakeIndicator: { getState: function () { return Promise.resolve(false); }, setState: function () { return Promise.resolve(); }, onState: function () { return function () {}; } },
    updates: {
      getStatus: function () {
        var v = "";
        var base = (CONFIG && CONFIG.base) ? CONFIG.base : "/proxy/dashboard";
        var url = base.replace(/\/+$/, "") + "/api/app/update/check";
        function fallback() { return { appVersion: v, currentVersion: v, currentSha: null, branch: null, behind: 0, updateAvailable: false, supported: true }; }
        try {
          return fetch(url, { headers: { "X-Hermes-Session-Token": token } })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (d) {
              var ver = (d && d.current) ? d.current : v;
              return { appVersion: ver, currentVersion: ver, currentSha: (d && d.sha) || null, branch: (d && d.branch) || null, behind: (d && d.behind) || 0, updateAvailable: !!(d && d.updateAvailable), supported: true };
            })
            .catch(function () { return fallback(); });
        } catch (e) { return Promise.resolve(fallback()); }
      },
      onProgress: function () { return Promise.resolve(); },
      subscribe: function () { return function () {}; },
      check: function () {
        var base = (CONFIG && CONFIG.base) ? CONFIG.base : "/proxy/dashboard";
        var url = base.replace(/\/+$/, "") + "/api/app/update/check";
        var fallback = { updateAvailable: false, supported: true, branch: null, currentSha: null, behind: 0, fetchedAt: Date.now() };
        try {
          return fetch(url, { headers: { "X-Hermes-Session-Token": token } })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (d) {
              return {
                updateAvailable: !!(d && d.updateAvailable),
                currentVersion: (d && d.current) || null,
                latestVersion: (d && d.latest) || null,
                branch: (d && d.branch) || null,
                currentSha: (d && d.sha) || null,
                behind: (d && d.behind) || 0,
                supported: true,
                fetchedAt: Date.now(),
              };
            })
            .catch(function () { return fallback; });
        } catch (e) { return Promise.resolve(fallback); }
      },
      install: function () { return Promise.resolve(); },
      list: function () { return Promise.resolve([]); },
      updateAll: function () { return Promise.resolve(); },
      remove: function () { return Promise.resolve(); },
      setPrimary: function () { return Promise.resolve(); },
      apply: function () {
        // 「立即更新」：同步用户仓库最新 Build——触发 GitHub Actions 构建（/api/app/update/dispatch），
        // 构建完成后 update/check 会检测到新版本并提示安装
        var base = (CONFIG && CONFIG.base) ? CONFIG.base : "/proxy/dashboard";
        var url = base.replace(/\/+$/, "") + "/api/app/update/dispatch";
        try {
          return fetch(url, { method: "POST", headers: { "X-Hermes-Session-Token": token, "Content-Type": "application/json" }, body: "{}" })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (d) { return { ok: !!(d && d.ok), error: (d && d.error) || "", message: (d && d.error) || (d && d.ok ? "已触发同步构建" : ""), version: (d && d.version) || null }; })
            .catch(function () { return { ok: false, error: "网络请求失败" }; });
        } catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
      },
      run: function () { return Promise.resolve(); },
      test: function () { return Promise.resolve(); },
      save: function () { return Promise.resolve(); },
      emit: function () { return Promise.resolve(); },
    },
    quickEntry: { get: function () { return Promise.resolve(null); }, onToggle: function () { return function () {}; } },
    themeMarketplace: { list: function () { return Promise.resolve([]); }, install: function () { return Promise.resolve(); } },
    cloud: { login: function () { return Promise.resolve({ signedIn: false, error: "web: 未配置云端登录" }); }, logout: function () { return Promise.resolve({ signedIn: false }); }, signOut: function () { return Promise.resolve({ signedIn: false }); }, isSignedIn: function () { return Promise.resolve({ signedIn: false }); }, discover: function () { return Promise.resolve({ agents: [], org: null, needsOrgSelection: false }); }, agentSignIn: function () { return Promise.resolve(null); }, connect: function () { return Promise.resolve({ ok: false, error: "web: 不可用" }); } },
    capabilities: {},
    composerPopout: {},
    composer: {},
    uninstall: {
      summary: function () { return Promise.resolve({ hermes_home: "", agent_installed: false, gui_installed: true, source_built_artifacts: [], packaged_app_paths: [], userdata_dir: "", userdata_exists: true, platform: "web" }); },
      run: function () { return Promise.resolve({ ok: false, error: "web 版请在飞牛应用中心卸载" }); },
    },
    connections: {
      list: function () { return Promise.resolve({ version: 1, primary: "", secureTokenStorage: false, connections: [] }); },
      save: function () { return Promise.resolve({ ok: false, error: "web: 不支持保存连接" }); },
      remove: function () { return Promise.resolve({ ok: false }); },
      setPrimary: function () { return Promise.resolve({ ok: false }); },
      test: function () { return Promise.resolve({ ok: false, reachable: false, authMode: "unknown" }); },
      updateAll: function () { return Promise.resolve({ ok: true, results: [] }); },
      onChanged: function () { return function () {}; },
      onActiveConnectionInvalidated: function () { return function () {}; },
      get: function () { return Promise.resolve(null); },
      setActive: function () { return Promise.resolve(); },
    },
    themes: { list: function () { return Promise.resolve([]); }, get: function () { return Promise.resolve(null); }, set: function () { return Promise.resolve(); }, market: function () { return Promise.resolve({ themes: [] }); } },
    model: { get: function () { return Promise.resolve(null); }, set: function () { return Promise.resolve(); }, list: function () { return Promise.resolve([]); }, test: function () { return Promise.resolve({ ok: true }); } },
    coder: { get: function () { return Promise.resolve(null); }, set: function () { return Promise.resolve(); } },
    research: { get: function () { return Promise.resolve(null); }, set: function () { return Promise.resolve(); } },
    pet: { get: function () { return Promise.resolve(null); }, set: function () { return Promise.resolve(); } },
    git: { listBranches: function () { return Promise.resolve([]); }, getStatus: function () { return Promise.resolve(null); }, review: function () { return Promise.resolve(null); } },
    dataUrlReadMax: {
      get: function () { var v = parseInt(localStorage.getItem("hermes.web.dataUrlMaxMb") || "", 10); var cur = Number.isFinite(v) && v >= 1 ? v : 16; return Promise.resolve({ defaultMaxMb: 16, maxBytes: cur * 1024 * 1024, maxMb: cur }); },
      set: function (maxMb) { var m = Math.max(1, Math.min(512, Math.round(Number(maxMb) || 16))); try { localStorage.setItem("hermes.web.dataUrlMaxMb", String(m)); } catch (e) {} return Promise.resolve({ defaultMaxMb: 16, maxBytes: m * 1024 * 1024, maxMb: m }); },
    },
    settings: {
      getDefaultProjectDir: function () { return Promise.resolve({ dir: "" }); },
      get: function () { return Promise.resolve(null); },
      set: function () { return Promise.resolve(); },
      reset: function () { return Promise.resolve(); },
      getProjectDir: function () { return Promise.resolve({ dir: "" }); },
      pickDefaultProjectDir: function () { return Promise.resolve({ canceled: true, dir: null }); },
      getTheme: function () { return Promise.resolve({}); },
    },
    sanitizeWorkspaceCwd: function () { return Promise.resolve(""); },
    getDefaultProjectDir: function () { return Promise.resolve({ dir: "" }); },
    onBackendExit: function () { return function () {}; },
    onBootProgress: function () { return function () {}; },
    onBootstrapEvent: function () { return function () {}; },
    onConnectionApplied: function () { return function () {}; },
    onPowerResume: function () { return function () {}; },
    onPreviewFileChanged: function () { return function () {}; },
    onWindowStateChanged: function () { return function () {}; },
    onFoundInPage: function () { return function () {}; },
  };

  var proxied = new Proxy(core, {
    get: function (obj, prop) {
      if (prop in obj) return obj[prop];
      if (prop in nested) return nested[prop];
      // 事件订阅方法(onXxx):返回"取消函数"(同步),renderer 用 const unsub = desktop.onXxx(cb); unsub()
      if (typeof prop === "string" && /^on[A-Z]/.test(prop)) {
        return function () { return function () {}; };
      }
      return makeFallback();
    },
  });

  // 嵌套对象的方法访问也走兜底(属性不存在时返回万能兜底,避免 .method() 崩溃)
  Object.keys(nested).forEach(function (k) {
    var base = nested[k];
    if (base && typeof base === "object" && !Array.isArray(base)) {
      nested[k] = new Proxy(base, {
        get: function (t, prop) {
          if (prop in t) return t[prop];
          if (typeof prop === "string" && /^on[A-Z]/.test(prop)) {
            return function () { return function () {}; };
          }
          return makeFallback();
        },
      });
    }
  });

  window.hermesDesktop = proxied;
  window.__HERMES_WEB_SHIM_LOADED__ = true;
})();

// ═══ Desktop UI 汉化层（DOM 级，覆盖官方 i18n 未翻译的硬编码英文）═══
(function () {
  "use strict";
  var DICT = { 'Billing':'账单','Connect your Nous account':'连接你的 Nous 账户','Run /portal in the TUI or open the Nous portal to connect your account.':'在 TUI 中运行 /portal 或打开 Nous 门户以连接你的账户。','Open portal':'打开门户','Balance':'余额','Plan':'套餐','Auto-refill':'自动充值','No payment method on file':'未绑定支付方式','Add payment method':'添加支付方式','Buy credits now':'立即购买额度','Choose how much':'选择金额','Custom credit amount':'自定义额度金额','Back to billing':'返回账单','Payment & credits':'支付与额度','Usage':'用量','Free':'免费','credits/mo':'额度/月','No active subscription':'无有效订阅','Renews':'续费于','Changes to':'变更至','Cancels on':'取消于','Change plan':'更换套餐','View plans':'查看套餐','Subscription details are unavailable':'订阅详情不可用','Card confirmation needed':'需要卡片确认','Charge could not':'扣款失败','Check the portal':'请查看门户','Add one on the portal.':'请在门户上添加。','Top-up':'充值','auto-refill card':'自动充值卡','customer default':'客户默认','subscription card':'订阅卡','Remote Spending is allowed for this terminal.':'已允许此终端进行远程消费。','Verification complete':'验证完成','Auto-refill updated.':'自动充值已更新。','Auto-refill turned off.':'自动充值已关闭。','Verification finished without allowing Remote Spending for this terminal.':'验证已完成，但未允许此终端进行远程消费。','Verification was not approved':'验证未获批准','The billing service accepted the request but did not return a charge id.':'计费服务已接受请求但未返回扣款 ID。','Charge could not be tracked':'无法跟踪扣款','Add credits':'添加额度','Buy':'购买','Nous':'诺斯','Midnight':'午夜','Ember':'余烬','Mono':'单色','Cyberpunk':'赛博朋克','Slate':'石板蓝','Glass neutrals with Nous blue accents':'玻璃质感中性色，配诺斯蓝点缀','Deep blue-violet with cool accents':'深蓝紫色，冷色点缀','Warm crimson and bronze — forge vibes':'暖绯红与古铜，锻造氛围','Clean grayscale — minimal and focused':'纯净灰度，极简专注','Neon green on black — matrix terminal':'黑底霓虹绿，矩阵终端风','Cool slate blue — focused developer theme':'冷石板蓝，专注的开发者主题','Search your themes or the VS Code Marketplace...':'搜索你的主题或 VS Code 市场…','Search your themes or the VS Code Marketplace':'搜索你的主题或 VS Code 市场','Theme':'主题','Switch theme':'切换主题','Font':'字体','Theme default':'主题默认','Use the active theme\'s font':'使用当前主题的字体','Helpful':'乐于助人','Concise':'简洁','Technical':'技术向','Creative':'创意向','Teacher':'老师','Kawaii':'可爱','Catgirl':'猫娘','Pirate':'海盗','Shakespeare':'莎士比亚','Surfer':'冲浪手','Noir':'黑色电影','Uwu':'呜呜','Philosopher':'哲学家','Hype':'热血','None':'无','Manual':'手动','Smart':'智能','Off':'关闭','Project':'项目','Strict':'严格','Compressor':'压缩器','Default':'默认','Custom':'自定义','Auto':'自动','Native':'原始','Text':'文本','Local':'本地','Two-note comfort':'双音舒适','Glass ping':'玻璃提示音','Soft marimba':'轻柔马林巴','Tri-tone message':'三音消息','Airy whoosh':'轻快嗖声','Discovery cluster':'发现音组','Systems online':'系统上线','IBM terminal':'IBM 终端','Modem chirp':'调制解调器鸣叫','Wind chimes':'风铃','Terminal execution backend':'终端执行后端','Container image used when the execution backend is Docker.':'执行后端为 Docker 时使用的容器镜像。','Image used when the execution backend is Singularity.':'执行后端为 Singularity 时使用的镜像。','Image used when the execution backend is Modal.':'执行后端为 Modal 时使用的镜像。','Image used when the execution backend is Daytona.':'执行后端为 Daytona 时使用的镜像。','Docker':'Docker','Singularity':'Singularity','Modal':'Modal','Daytona':'Daytona','Browser engine for local mode: auto (default Chrome), lightpanda (faster, no screenshots), chrome':'本地模式浏览器引擎：auto（默认 Chrome）、lightpanda（更快，无截图）、chrome','Get Key':'获取密钥','Optional':'可选','Paste':'粘贴','AGENT BROWSER ENGINE':'智能体浏览器引擎','BRAVE SEARCH':'Brave 搜索','BROWSER USE':'浏览器使用','BROWSERBASE':'BrowserBase','ELEVENLABS':'ElevenLabs','EXA':'Exa','FAL':'Fal','FIRECRAWL':'Firecrawl','Toggle layout edit mode':'切换布局编辑模式','Keyboard Shortcuts':'键盘快捷键','Speech to Text':'语音转文字','Text to Speech':'文字转语音','Speech to text':'语音转文字','Text to speech':'文字转语音','Recording':'录音','Speech-To-Text Provider':'语音转文字提供方','Text-To-Speech Provider':'文字转语音提供方','Echo Transcripts':'回声转录','Post the raw transcript of voice messages back to the chat.':'将语音消息的原始转写文本发回会话。','Transcription Language':'转写语言','Transcription Model':'转写模型','Read Responses Aloud':'朗读回复','Voice Shortcut':'语音快捷键','Max Recording Length':'最长录音时长','System Default':'系统默认','Search...':'搜索…','Custom Endpoints':'自定义端点','Local custom endpoint':'本地自定义端点','Point at any compatible endpoint':'指向任意兼容端点','Open folder':'打开文件夹','Rescan':'重新扫描','Reveal in file manager':'在文件管理器中显示','Send test notification':'发送测试通知','Preview':'预览','Settings':'设置','Search':'搜索','Loading':'加载中','Save':'保存','Cancel':'取消','Apply':'应用','Reset':'重置','Delete':'删除','Edit':'编辑','Add':'添加','Remove':'移除','Enable':'启用','Disable':'停用','Enabled':'已启用','Disabled':'已停用','Connect':'连接','Connected':'已连接','Disconnected':'未连接','Update':'更新','Install':'安装','Uninstall':'卸载','Restart':'重启','Stop':'停止','Start':'启动','Running':'运行中','Stopped':'已停止','Test':'测试','Manage':'管理','Close':'关闭','Back':'返回','Next':'下一步','Previous':'上一步','Refresh':'刷新','Retry':'重试','Clear':'清除','Copy':'复制','Copy path':'复制路径','Show':'显示','Hide':'隐藏','Updated':'更新时间','Status':'状态','Profile':'配置档案','Created':'创建时间','Tokens':'令牌数','Cost':'成本','Open':'打开','Draft':'草稿','Merged':'已合并','Closed':'已关闭','No PR':'无 PR','Needs input':'需要输入','Working':'处理中','Unread':'未读','Idle':'空闲','Filters':'筛选器','Grouping':'分组','Ordering':'排序','Inbox style':'收件箱样式','Pull request':'拉取请求','Archived':'已归档','Reset to defaults':'恢复默认','Expand all':'全部展开','Collapse all':'全部收起','Mark all as read':'全部标为已读','All Configuration Profiles':'全部配置档案','Display':'显示','Danger zone':'危险操作区','Uninstall Hermes':'卸载 Hermes','Choose how much to remove. The app closes to finish the job; reopen the installer any time to come back.':'选择要移除的内容。应用会关闭以完成操作；随时重新打开安装程序即可恢复。','Uninstall Chat GUI only':'仅卸载聊天界面','Remove this desktop app. The Hermes agent, your config, and chats all stay.':'移除这个桌面应用。Hermes 智能体、你的配置和聊天记录都会保留。','Remove Hermes Agent and its data':'移除 Hermes 智能体及其数据','SESSIONS':'会话','BOTS':'机器人','CRONJOBS':'定时任务','Sessions':'会话','Bots':'机器人','Cronjobs':'定时任务','New Agent':'新建智能体','Search bots':'搜索机器人…','Create Cronjob':'创建定时任务','Search bots to add':'搜索要添加的机器人','A named teammate with its own memory, skills, and chat.':'一个拥有独立记忆、技能和聊天的命名队友。','No custom endpoints':'暂无自定义端点','Add an OpenAI-compatible endpoint below.':'在下方添加一个兼容 OpenAI 的端点。','Provider ID':'提供方 ID','Endpoint URL':'端点 URL','Default Model':'默认模型','Use for new chats':'用于新对话','Discover models':'发现模型','Tiny':'微小','Base':'基础','Small':'小','Medium':'中','Large-V3':'大 V3','Large':'大','Stash':'暂存','Discard':'丢弃','Afr':'非洲','Search':'搜索','zh-CN-XiaoxiaoNeural':'晓晓（女·温暖）','zh-CN-XiaoyiNeural':'晓伊（女·活泼）','zh-CN-YunxiNeural':'云希（男·阳光）','zh-CN-YunjianNeural':'云健（男·沉稳）','zh-CN-YunxiaNeural':'云夏（男·少年）','zh-CN-YunyangNeural':'云扬（男·新闻）','zh-CN-liaoning-XiaobeiNeural':'晓北（女·东北）','zh-CN-shaanxi-XiaoniNeural':'晓妮（女·陕西）','zh-CN-XiaomoNeural':'晓墨（女·多风格）','zh-CN-XiaohanNeural':'晓涵（女·温柔）','zh-CN-XiaomengNeural':'晓梦（女·甜美）','zh-CN-XiaoxuanNeural':'晓萱（女·儿童）','zh-CN-XiaoyanNeural':'晓颜（女·儿童）','zh-TW-HsiaoChenNeural':'曉臻（女·台湾）','zh-TW-HsiaoYuNeural':'曉雨（女·台湾）','zh-HK-HiuGaaiNeural':'曉佳（女·粤语）','zh-HK-HiuMaanNeural':'曉曼（女·粤语）','zh-HK-WanLungNeural':'雲龍（男·粤语）','en-US-AriaNeural':'Aria（英文女声）','en-US-JennyNeural':'Jenny（英文女声）','en-US-AndrewNeural':'Andrew（英文男声）','en-US-BrianNeural':'Brian（英文男声）','en-US-GuyNeural':'Guy（英文男声）','en-GB-SoniaNeural':'Sonia（英音女声）','Providers':'提供方','Provider':'提供方','API Keys':'API 密钥','Accounts':'账号','Gateway':'网关','Archived Chats':'已归档对话','About':'关于','Notifications':'通知','Plugins':'插件','Model':'模型','Chat':'对话','Appearance':'外观','Workspace':'工作区','Security':'安全','Memory & Context':'记忆与上下文','Voice':'语音','Advanced':'高级','Safety':'安全','Memory':'记忆','Conversation':'对话','Completion Sound':'完成提示音','Approval Mode':'审批模式','Code Execution Mode':'代码执行模式','Context Engine':'上下文引擎','Working Directory':'工作目录','Execution Backend':'执行后端','Command Timeout':'命令超时','Persistent Shell':'持久化 Shell','Environment Variable Passthrough':'环境变量透传','File Read Limit':'文件读取上限','Max Attachment Size':'最大附件大小','Image Attachments':'图片附件','Personality':'人格','Timezone':'时区','Reasoning Blocks':'推理过程块','Auto-detect':'自动检测','Enabled Toolsets':'启用的工具集','Tools':'工具','Keys':'密钥' };
  var SKIP = { INPUT:1, TEXTAREA:1, SCRIPT:1, STYLE:1, CODE:1, PRE:1, SELECT:1, OPTION:1 };
  function translate(root, visited) {
    if (!root) return;
    visited = visited || [];
    if (visited.indexOf(root) >= 0) return;
    visited.push(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false), n;
    while ((n = w.nextNode())) {
      var t = n.nodeValue; if (!t) continue;
      var k = t.trim(); if (!k || !DICT[k] || k === DICT[k]) continue;
      var p = n.parentNode; if (!p || p.nodeType !== 1) continue;
      if (SKIP[p.tagName] || p.isContentEditable) continue;
      n.nodeValue = t.replace(k, DICT[k]);
    }
    // 递归翻译 Shadow DOM（官方 UI 部分组件用 shadowRoot）
    var els = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.shadowRoot) translate(el.shadowRoot, visited);
    }
  }
  function run() { try { translate(document.body); } catch (e) {} }
  var obs = null;
  function start() {
    if (obs) return;
    obs = new MutationObserver(function () {
      if (obs) obs.disconnect();
      try { run(); } catch (e) {}
      if (obs) obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setInterval(function () { try { translate(document.body); } catch (e) {} }, 500);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { run(); start(); });
  } else { run(); start(); }
})();


// ═══ 关于页版本显示修复：把"版本不可用"替换为真实版本（从 update/check API）═══
(function () {
  "use strict";
  var VER = null, BRANCH = null, SHA = null;
  var tried = false;
  function getBase() {
    try { return (window.__HERMES_WEB_CONFIG__ && window.__HERMES_WEB_CONFIG__.base || '/proxy/dashboard').replace(/\/+$/, ''); } catch (e) { return '/proxy/dashboard'; }
  }
  function fetchVersion() {
    if (tried) return;
    tried = true;
    try {
      fetch(getBase() + '/api/app/update/check', {
        headers: { 'X-Hermes-Session-Token': (window.__HERMES_WEB_CONFIG__ && window.__HERMES_WEB_CONFIG__.token) || '' }
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          if (d && d.current) { VER = String(d.current); }
          if (d && d.branch) { BRANCH = String(d.branch); }
          if (d && d.sha) { SHA = String(d.sha); }
          if (VER || BRANCH || SHA) { applyVer(); }
        }).catch(function () {});
    } catch (e) {}
  }
  function applyVer() {
    if (!document.body) return;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false), n;
    while ((n = w.nextNode())) {
      var t = n.nodeValue || '';
      if (VER && t.indexOf('版本不可用') >= 0) { n.nodeValue = t.replace('版本不可用', VER); }
      else if (VER && t.indexOf('Version unavailable') >= 0) { n.nodeValue = t.replace('Version unavailable', VER); }
      else if (t.indexOf('分支 unknown') >= 0) {
        n.nodeValue = t.replace(/分支 unknown · 提交 unknown/g, '分支 ' + (BRANCH || 'main') + ' · 提交 ' + (SHA || ''));
      }
      else if (t.indexOf('Branch unknown') >= 0) {
        n.nodeValue = t.replace(/Branch unknown · Commit unknown/g, 'Branch ' + (BRANCH || 'main') + ' · Commit ' + (SHA || ''));
      }
    }
  }
  var obs = null;
  function start() {
    if (obs) return;
    obs = new MutationObserver(function () { if (obs) obs.disconnect(); applyVer(); if (obs) obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setInterval(applyVer, 800);
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { fetchVersion(); start(); }); }
  else { fetchVersion(); start(); }
})();

// ═══ 移动端适配层（iOS 安全区 + 输入框防缩放 + 触摸优化）═══
(function () {
  "use strict";
  function isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') || (window.innerWidth || 0) <= 820;
  }
  function apply() {
    if (!isMobile()) return;
    var style = document.getElementById('hermes-mobile-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'hermes-mobile-style';
      document.head.appendChild(style);
    }
    // 1) iOS/Android 输入框 ≥16px，防止聚焦时页面自动缩放
    // 2) safe-area 适配：底部横条（iPhone）/ 刘海屏
    // 3) 聊天输入区贴底，不被手势条遮挡
    style.textContent = [
      'html,body{height:100%;overflow-y:auto;-webkit-text-size-adjust:100%;}',
      'input,textarea,select{font-size:16px!important;}',
      '@supports (padding: env(safe-area-inset-bottom)){',
      '  body{padding-bottom:env(safe-area-inset-bottom);}',
      '  .composer-shell,.composer{padding-bottom:calc(env(safe-area-inset-bottom) + 0.5rem)!important;}',
      '  .hud-root,.pet-root{bottom:env(safe-area-inset-bottom)!important;}',
      '}',
      '@supports (padding: constant(safe-area-inset-bottom)){',
      '  body{padding-bottom:constant(safe-area-inset-bottom);}',
      '}',
      // 移动端触控：增大可点区域、禁双击缩放
      'button,[role=button]{touch-action:manipulation;}',
      '*{-webkit-tap-highlight-color:transparent;}',
      // 移动端侧边栏抽屉全屏
      '@media (max-width: 640px){',
      '  .app-sidebar{width:min(85vw,20rem)!important;}',
      '}'
    ].join('\n');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else { apply(); }
  // 竖屏/横屏切换与窗口尺寸变化时重新应用（安全区数值会变）
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', function () { setTimeout(apply, 200); });
})();


// ═══ 时区搜索框 placeholder 修复：时区字段空值特判（placeholder=systemDefault）把
// 官方 SearchableSelect 的搜索框占位符也改成了"系统默认"，这里只修搜索框为"搜索时区…"
//（trigger 上"系统默认"的显示保留，符合"空值时显示系统默认"的预期）═══
(function () {
  "use strict";
  function fixTz() {
    try {
      var inputs = document.querySelectorAll('input[placeholder="系统默认"]');
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].placeholder === "系统默认") inputs[i].placeholder = "搜索时区…";
      }
    } catch (e) {}
  }
  fixTz();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fixTz);
  }
  var obsTz = null;
  try {
    obsTz = new MutationObserver(function () { fixTz(); });
    obsTz.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setInterval(fixTz, 1200);
})();
