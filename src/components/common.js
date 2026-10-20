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
const nextJump = document.getElementById('nextJump');
if (nextJump) nextIO.observe(nextJump);
