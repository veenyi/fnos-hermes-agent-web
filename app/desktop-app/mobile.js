/* ═══════════════════════════════════════════════════════════════════
   Hermes desktop-app — 移动端适配层脚本 (mobile adaptation script)
   -------------------------------------------------------------------
   配合 mobile.css 工作。设计要点：

   1. 官方应用在 ≤768px 会把「隐藏/显示侧边栏」按钮禁用
      （实测 768/700/412 点击无效果，800/900 正常）——
      即手机宽度下原生按钮是个摆设。本脚本在移动端【接管】该
      按钮的点击来开关抽屉；桌面宽度不干预，按钮行为保持原生。
   2. 以应用原生侧边栏状态为同步基准（MutationObserver 观察
      列表容器内联 display:none / 按钮 aria-label）：
       原生收起 → 抽屉关；原生展开 → 抽屉开（非接管场景）
   3. 移动端启动：抽屉默认关闭（引导窗口内不自动开抽屉，
      最多补点两次原生按钮尝试归一状态，失败则标记接管模式）。
   4. 点抽屉内导航/会话项、或点遮罩 → 关抽屉（接管模式下
      同步覆盖按钮 aria-label，保证读屏正确）。
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.matchMedia) return;

  var MQ = window.matchMedia("(max-width: 768px)");

  function isMobile() {
    return MQ.matches;
  }

  var shell = null;     // master-detail flex 行（data-hm-shell）
  var list = null;      // 列表区（data-hm-list）
  var detail = null;    // 会话区（data-hm-detail）
  var root = null;      // 根容器（data-hm-root）
  var overlay = null;
  var nativeBtn = null; // 原生「隐藏/显示侧边栏」按钮
  var stateWatcher = null;
  var nativeInert = false; // 接管模式：官方按钮在移动端被禁用
  var bootUntil = 0;
  var bootClicks = 0;
  var MAX_BOOT_CLICKS = 2;

  /* ── 定位布局 ────────────────────────────────────────────────── */
  function findAndTag() {
    var listPane = document.querySelector(
      '[data-zone-header="true"][data-tree-group]'
    );
    if (!listPane) return false;

    var wrapper = listPane.parentElement;
    if (!wrapper) return false;
    var master = wrapper.parentElement;
    if (!master) return false;

    var det = null;
    for (var i = 0; i < master.children.length; i++) {
      if (master.children[i] !== wrapper) {
        det = master.children[i];
        break;
      }
    }
    if (!det) return false;

    var r = master.parentElement
      ? master.parentElement.parentElement
      : null;

    if (shell === master && list === wrapper && detail === det) {
      return true;
    }

    clearTags();
    shell = master;
    list = wrapper;
    detail = det;
    root = r;
    tag(shell, "data-hm-shell");
    tag(list, "data-hm-list");
    tag(detail, "data-hm-detail");
    if (root) tag(root, "data-hm-root");
    return true;
  }

  function tag(el, name) {
    try { el.setAttribute(name, ""); } catch (e) {}
  }

  function clearTags() {
    if (shell) try { shell.removeAttribute("data-hm-shell"); } catch (e) {}
    if (list) try { list.removeAttribute("data-hm-list"); } catch (e) {}
    if (detail) try { detail.removeAttribute("data-hm-detail"); } catch (e) {}
    if (root) try { root.removeAttribute("data-hm-root"); } catch (e) {}
    shell = list = detail = root = null;
  }

  /* ── 原生「隐藏/显示侧边栏」按钮 ─────────────────────────────── */
  function findNativeBtn() {
    var found = null;
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var ic = btns[i].querySelector("i");
      if (ic && (ic.className || "").indexOf("codicon-layout-sidebar-left") >= 0) {
        found = btns[i];
        break;
      }
    }
    return found;
  }

  /* 应用原生侧边栏状态：原生隐藏时列表容器带内联 display:none */
  function appSidebarHidden() {
    return !!(list && list.style && list.style.display === "none");
  }

  /* ── 抽屉开关（纯 class，视觉由 mobile.css 控制） ────────────── */
  function setOpen(open) {
    var html = document.documentElement;
    if (open) html.classList.add("hm-nav-open");
    else html.classList.remove("hm-nav-open");
    syncLabel();
  }

  function isOpen() {
    return document.documentElement.classList.contains("hm-nav-open");
  }

  /* 接管模式下覆盖原生按钮文案，保证读屏与实际抽屉状态一致 */
  function syncLabel() {
    if (!nativeInert || !nativeBtn || !isMobile()) return;
    try {
      nativeBtn.setAttribute(
        "aria-label",
        isOpen() ? "关闭导航" : "打开导航"
      );
    } catch (e) {}
  }

  /* 以应用原生状态为基准同步抽屉：
     - 原生收起 → 关抽屉
     - 原生展开 → 仅在「非接管模式 + 引导窗口结束后」自动开抽屉 */
  function syncFromAppState() {
    if (appSidebarHidden()) {
      setOpen(false);
    } else if (isMobile() && !nativeInert && Date.now() > bootUntil) {
      setOpen(true);
    }
  }

  /* 启动时尝试把原生状态归一到「收起」；若点击后状态无变化，
     说明官方按钮在移动端被禁用 → 进入接管模式。 */
  function settleBootState() {
    if (!isMobile() || !nativeBtn) return;
    if (bootClicks >= MAX_BOOT_CLICKS) return;
    if (appSidebarHidden()) return;
    bootClicks++;
    try { nativeBtn.click(); } catch (e) {}
    setTimeout(function () {
      if (isMobile() && !appSidebarHidden()) nativeInert = true;
    }, 200);
  }

  /* ── 关闭抽屉（同步原生状态 / 接管文案） ────────────────────── */
  function closeDrawer() {
    setOpen(false);
    if (nativeBtn && !nativeInert && !appSidebarHidden()) {
      try { nativeBtn.click(); } catch (e) {}
    }
  }

  /* ── 接管原生按钮点击（移动端抽屉开关） ─────────────────────── */
  function onNativeClick() {
    if (!isMobile()) return; // 桌面宽度保持原生行为
    if (nativeInert) {
      setOpen(!isOpen());
    }
    // 非接管模式：官方按钮自己会切状态，观察器负责同步
  }

  /* ── 遮罩 ────────────────────────────────────────────────────── */
  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) return;
    overlay = document.createElement("div");
    overlay.className = "hm-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.addEventListener("click", function () {
      closeDrawer();
    });
    document.body.appendChild(overlay);
    overlay.style.display = isMobile() ? "block" : "none";
  }

  /* ── 抽屉内点击：导航类元素自动收起 ──────────────────────────── */
  function shouldAutoClose(target) {
    var el = target;
    while (el && el !== list && el !== document.body) {
      if (el.getAttribute && el.hasAttribute("aria-expanded")) return false;
      if (el.classList && el.classList.contains("group/disclosure-row")) return false;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return false;
      if (
        el.tagName === "A" ||
        el.tagName === "BUTTON" ||
        (el.getAttribute && el.getAttribute("role") === "menuitem")
      ) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function onListClick(e) {
    if (!isOpen()) return;
    if (shouldAutoClose(e.target)) {
      // 等应用先处理这次点击（打开会话/新建等）再收起
      setTimeout(function () { closeDrawer(); }, 60);
    }
  }

  /* ── 状态观察：原生状态变化 → 同步抽屉 ──────────────────────── */
  function watchState() {
    if (stateWatcher) stateWatcher.disconnect();
    stateWatcher = new MutationObserver(function () {
      syncFromAppState();
    });
    if (list) {
      stateWatcher.observe(list, {
        attributes: true,
        attributeFilter: ["style"],
      });
    }
    if (nativeBtn) {
      stateWatcher.observe(nativeBtn, {
        attributes: true,
        attributeFilter: ["aria-label"],
      });
    }
  }

  /* ── 移动/桌面切换 ───────────────────────────────────────────── */
  function onMobileChange() {
    var on = isMobile();
    if (overlay) overlay.style.display = on ? "block" : "none";
    if (!on) {
      setOpen(false);
      return;
    }
    settleBootState();
    syncFromAppState();
  }

  /* ── 初始化 ──────────────────────────────────────────────────── */
  var retry = 0;
  var MAX_RETRY = 60;
  function initOnce() {
    if (!findAndTag()) return false;
    nativeBtn = findNativeBtn();
    ensureOverlay();
    watchState();
    if (nativeBtn) nativeBtn.addEventListener("click", onNativeClick, true);
    if (list) list.addEventListener("click", onListClick, true);
    MQ.addEventListener
      ? MQ.addEventListener("change", onMobileChange)
      : MQ.addListener(onMobileChange);
    // 引导窗口：布局挂载后 4s 内不允许自动开抽屉；窗口内补点
    // 原生按钮归一状态（最多两次），兜底应用引导阶段的状态重置。
    bootUntil = Date.now() + 4000;
    settleBootState();
    setTimeout(function () {
      settleBootState();
      syncFromAppState();
    }, 2000);
    setTimeout(function () {
      syncFromAppState();
    }, 4500);
    onMobileChange();
    return true;
  }

  if (!initOnce()) {
    var mo = new MutationObserver(function () {
      if (!initOnce()) return;
      mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // React 可能整体重挂载布局：持续观察，丢失标记则重新打标并重建挂钩
  var keepAlive = new MutationObserver(function () {
    if (!shell || !shell.isConnected || !list.isConnected || !detail.isConnected) {
      if (!findAndTag()) return;
      nativeBtn = findNativeBtn();
      ensureOverlay();
      watchState();
      if (nativeBtn) nativeBtn.addEventListener("click", onNativeClick, true);
      if (list) list.addEventListener("click", onListClick, true);
      syncFromAppState();
    }
  });
  keepAlive.observe(document.body, { childList: true, subtree: true });

  // 调试钩子
  try {
    window.__hmDebug = {
      getState: function () {
        return {
          navOpen: isOpen(),
          appHidden: appSidebarHidden(),
          nativeInert: nativeInert,
          shellTagged: !!(shell && shell.isConnected),
          listConnected: !!(list && list.isConnected),
          nativeBtn: !!nativeBtn,
          overlay: !!overlay,
          mobile: isMobile(),
          bootUntil: bootUntil,
        };
      },
      closeDrawer: closeDrawer,
      sync: syncFromAppState,
    };
  } catch (e) {}
})();
