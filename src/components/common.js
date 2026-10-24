/* ============================================================
   永远在线的"搭子" · 全站共享脚本
   说明：所有章节页面统一引用本文件（放在页面内联脚本之前）。
   包含：顶部导航进度条、通用工具（matchReduce / countUp）、
        通用交互（进场 reveal / 章末跳转）。
   ============================================================ */

// —— 顶部导航 · 阅读进度条 ——
(function () {
  const bar = document.getElementById('siteProgress');
  if (!bar) return;
  const update = function () {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    const p = max > 0 ? (h.scrollTop / max) * 100 : 0;
    bar.style.width = p + '%';
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
})();

// —— 工具：是否偏好减少动效 ——
function matchReduce() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// —— 工具：取小数位数 ——
function decimalPlaces(n) {
  const s = String(n);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

// —— 工具：数字滚动（count-up，自动匹配小数位，全站统一） ——
// 两种用法：① countUp(el, target, duration, suffix)；② countUp(el) —— 从 data-count / data-suffix 读取
function countUp(el, target, duration, suffix) {
  if (target === undefined) {
    target = parseFloat(el.dataset.count);
    suffix = el.dataset.suffix || '';
    duration = 900;
  }
  duration = duration || 800;
  suffix = suffix || '';
  const dp = decimalPlaces(target);
  if (matchReduce()) { el.textContent = target.toFixed(dp) + suffix; return; }
  const start = performance.now();
  const frame = function (t) {
    const p = Math.min((t - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * eased).toFixed(dp) + suffix;
    if (p < 1) requestAnimationFrame(frame);
    else el.textContent = target.toFixed(dp) + suffix;
  };
  requestAnimationFrame(frame);
}

// —— 通用：进场 reveal（.reveal 元素滚动进入时加 .in） ——
const revealIO = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) {
      e.target.classList.add('in');
      revealIO.unobserve(e.target);
    }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => revealIO.observe(el));

// —— 通用：章末跳转 .is-inview ——
const nextIO = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) e.target.classList.add('is-inview');
  });
}, { threshold: 0.5 });
const nextJumpEl = document.getElementById('nextJump');
if (nextJumpEl) nextIO.observe(nextJumpEl);

/* ============================================================
   跨章回看：在封面向上过度滚动 → 回到上一章末尾
   ------------------------------------------------------------
   流畅度优化：
   1) 目标页：脚本执行即定位到章末（不等 load），用 opacity 淡入
      遮罩「先看到封面再跳到底」的闪烁；load / setTimeout 兜底重对齐。
   2) 当前页：顶部向上滚时给页面一个橡皮筋式 translateY 反馈，
      超过阈值才跳转，避免「卡住」感。
   3) 跳转前当前页淡出、目标页淡入，形成章节过渡。
   ============================================================ */

// —— ① 目标页：fromBottom=1 → 立即定位到章末 + 淡入 ——
(function () {
  if (location.search.indexOf('fromBottom=1') === -1) return;
  const html = document.documentElement;
  const body = document.body;
  const savedSB = html.style.scrollBehavior;

  // 立即隐藏：脚本在 body 末尾执行，此时浏览器尚未完成首次绘制，
  // 设 opacity=0 可避免露出封面后再跳到底部的闪烁
  body.style.opacity = '0';

  function toChapterEnd() {
    const target = document.getElementById('nextJump');
    const y = target
      ? target.getBoundingClientRect().top + window.pageYOffset
      : html.scrollHeight - html.clientHeight;
    html.style.scrollBehavior = 'auto';
    window.scrollTo(0, y);
    requestAnimationFrame(() => {
      html.style.scrollBehavior = savedSB || '';
    });
  }

  // 立即定位（DOM 已解析，#nextJump 位置基本确定）
  toChapterEnd();
  // 资源加载后再对齐一次（图片 / ECharts 撑高）
  if (document.readyState === 'complete') {
    toChapterEnd();
  } else {
    window.addEventListener('load', toChapterEnd);
  }
  setTimeout(toChapterEnd, 300);

  // 定位完成后淡入
  requestAnimationFrame(() => {
    body.style.transition = 'opacity .35s ease';
    body.style.opacity = '1';
  });
})();

// —— ② 当前页：顶部向上过度滚动 → 跳上一章 ——
(function () {
  const prev = document.body && document.body.dataset.prev;
  if (!prev) return;

  const EDGE = 3;            // 距顶部多少 px 内视为「已在封面边缘」
  const COOLDOWN = 1200;     // 跳转防抖
  const WHEEL_NEED = 18;     // 滚轮需累积向上滚动多少 px 才触发（降低，更跟手）
  const TOUCH_NEED = 36;     // 触屏手指需下移多少 px 才触发
  const RUBBER_MAX = 60;     // 橡皮筋最大位移 px
  let lastJump = 0;
  let wheelAccum = 0;
  let rubberY = 0;           // 当前橡皮筋位移
  let rafId = null;

  // 应用橡皮筋位移（requestAnimationFrame 节流，避免每帧写样式）
  function applyRubber() {
    rafId = null;
    if (rubberY > 0) {
      document.body.style.transform = 'translateY(' + rubberY + 'px)';
    } else {
      document.body.style.transform = '';
    }
  }
  function scheduleRubber() {
    if (rafId === null) rafId = requestAnimationFrame(applyRubber);
  }

  function goPrev() {
    const now = Date.now();
    if (now - lastJump < COOLDOWN) return;
    lastJump = now;
    // 跳转前淡出当前页，形成过渡
    document.body.style.transition = 'opacity .2s ease';
    document.body.style.opacity = '0';
    setTimeout(() => {
      const sep = prev.indexOf('?') > -1 ? '&' : '?';
      window.location.href = prev + sep + 'fromBottom=1';
    }, 180);
  }

  // 桌面端：滚轮
  window.addEventListener('wheel', (e) => {
    if (window.scrollY > EDGE) {
      wheelAccum = 0;
      if (rubberY > 0) { rubberY = 0; scheduleRubber(); }
      return;
    }
    if (e.deltaY < 0) {
      wheelAccum += -e.deltaY;
      // 橡皮筋反馈：累积量映射为位移，让用户感知"再往上就翻章"
      rubberY = Math.min(wheelAccum * 0.8, RUBBER_MAX);
      scheduleRubber();
      if (wheelAccum >= WHEEL_NEED) {
        wheelAccum = 0;
        rubberY = 0;
        scheduleRubber();
        goPrev();
      }
    } else {
      // 向下滚：回弹
      wheelAccum = 0;
      if (rubberY > 0) {
        rubberY = Math.max(0, rubberY - 8);
        scheduleRubber();
      }
    }
  }, { passive: true });

  // 移动端：触摸
  let startY = null;
  let moved = false;
  window.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      startY = e.touches[0].clientY;
      moved = false;
    }
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    if (window.scrollY > EDGE) { moved = false; return; }
    const dy = e.touches[0].clientY - startY; // 手指下移量
    if (dy > 0) {
      rubberY = Math.min(dy * 0.5, RUBBER_MAX);
      scheduleRubber();
    }
    if (dy > TOUCH_NEED && !moved) {
      moved = true;
      rubberY = 0;
      scheduleRubber();
      goPrev();
    }
  }, { passive: true });
  function endTouch() {
    startY = null;
    moved = false;
    if (rubberY > 0) { rubberY = 0; scheduleRubber(); }
  }
  window.addEventListener('touchend', endTouch, { passive: true });
  window.addEventListener('touchcancel', endTouch, { passive: true });

  // —— ③ 视觉提示：封面顶部「↑ 向上滚动 · 回到上一章」——
  const style = document.createElement('style');
  style.textContent = [
    '.prev-hint{',
    '  position:fixed;left:50%;top:56px;transform:translateX(-50%);',
    '  z-index:999;pointer-events:none;',
    '  font-size:12px;letter-spacing:.22em;color:rgba(255,255,255,.78);',
    '  background:rgba(15,37,50,.42);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);',
    '  padding:6px 16px;border-radius:20px;',
    '  opacity:0;transition:opacity .35s ease;white-space:nowrap;',
    '  text-shadow:0 1px 6px rgba(0,0,0,.5);',
    '}',
    '.prev-hint.show{opacity:1}',
    '@media (max-width:640px){.prev-hint{top:50px;font-size:11px;letter-spacing:.18em}}',
  ].join('');
  document.head.appendChild(style);

  const hint = document.createElement('div');
  hint.className = 'prev-hint';
  hint.textContent = '↑ 向上滚动 · 回到上一章';
  document.body.appendChild(hint);

  function syncHint() {
    if (window.scrollY < 180) hint.classList.add('show');
    else hint.classList.remove('show');
  }
  window.addEventListener('scroll', syncHint, { passive: true });
  syncHint();
})();
