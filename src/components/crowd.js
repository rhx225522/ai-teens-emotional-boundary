/* ==========================================================================
   人群场 · CrowdField
   参考 pudding.cool《A love story》的人群算法：seek 转向 + 弱分离 + 步态帧。
   素材：assets/images/小人/*.jpg → build-people-sprites.py → people-sprites.js
        （5 个角色 × 4 帧步态，透明底 WebP 图集，运行时零抠图开销）
   规模：每块画布 1000 人，左右两群各 500；作答后按比例分簇。
   行为：入场从画布下方奔跑聚拢 → 站成整齐网格 → 全员静止后停帧。
   性能：空间哈希邻域、离屏预渲染精灵、计数排序、视野剔除、停帧不再渲染。
   ========================================================================== */
(function () {
  "use strict";

  var TAU = Math.PI * 2;
  var ATLAS_COLS = 5;
  var ATLAS_ROWS = 4;
  var CELL_W = 64;
  var CELL_H = 90;
  var SPRITE_ASPECT = CELL_W / CELL_H;
  // 5 个角色的步态节奏（帧速倍率）
  var GAITS = [1.0, 1.28, 0.9, 1.08, 1.32];

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function hash(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function isRiskColor(hex) {
    if (!hex || hex.charAt(0) !== "#" || hex.length !== 7) return false;
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return r > 140 && r > g * 1.35 && r > b * 1.35;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.decoding = "async";
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("无法加载小人图集：" + src)); };
      img.src = src;
    });
  }

  function CrowdField(canvasId, bigNumId, options) {
    options = options || {};
    this.canvas = document.getElementById(canvasId);
    this.bigNumEl = bigNumId ? document.getElementById(bigNumId) : null;
    if (!this.canvas) return;

    this.ctx = this.canvas.getContext("2d", { alpha: true });
    this.count = options.count || 1000;
    this.mode = "idle";
    this.activeCount = 0;
    this.activePercent = 0;
    this.activeColor = "#D4A017";
    this.reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.running = false;
    this.visible = false;
    this.W = 640;
    this.H = 460;
    this.dpr = 1;
    this.size = 20;
    this.activeScale = 1;
    this.people = [];
    this._raf = 0;
    this._revealTimer = 0;
    this._last = 0;
    this._drawTick = 0;
    this._stillFrames = 0;
    this._interacted = false;
    this._atlas = null;
    this._atlasReady = false;
    this._atlasFailed = false;
    this._atlasSrc = options.atlasSrc || "";
    this._cache = null;
    this._order = null;
    this._counts = null;
    this._palettes = {};

    this.resize();
    this.buildPeople();
    this.layoutTargets();
    this._allocBuffers();

    var self = this;
    this._loop = this.loop.bind(this);

    if ("ResizeObserver" in window) {
      this._ro = new ResizeObserver(function () {
        // 入场前的尺寸变化只需重排落点；作答后不再重排，避免再动一次
        self.resize();
        self._allocBuffers();
        if (!self._interacted) self.layoutTargets();
        self.draw();
      });
      this._ro.observe(this.canvas);
    } else {
      window.addEventListener("resize", function () {
        self.resize();
        self._allocBuffers();
        if (!self._interacted) self.layoutTargets();
        self.draw();
      });
    }

        var self = this;
        if ("IntersectionObserver" in window) {
      this._io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            self.visible = entry.isIntersecting;
            if (self.visible) self.start();
            else self.stop();
          });
        },
        { threshold: 0.4 }
      );
      this._io.observe(this.canvas.parentElement || this.canvas);
    } else {
      this.visible = true;
      this.start();
    }

    this._loadAtlas();
  }

  CrowdField.prototype._allocBuffers = function () {
    var n = this.people.length;
    this._order = new Int32Array(n);
    this._gridNext = new Int32Array(n);
    var cell = Math.max((this.size * CELL_W) / CELL_H, 5);
    var cols = Math.ceil(this.W / cell) + 1;
    var rows = Math.ceil(this.H / cell) + 1;
    this._gridSize = cell;
    this._gridCols = cols;
    this._gridRows = rows;
    this._gridHead = new Int32Array(cols * rows);
  };

  CrowdField.prototype._loadAtlas = function () {
    var self = this;
    if (!this._atlasSrc) {
      this._atlasFailed = true;
      this.draw();
      return;
    }
    loadImage(this._atlasSrc)
      .then(function (img) {
        self._atlas = img;
        self._atlasReady = true;
        self._buildCache();
        self.draw();
      })
      .catch(function (err) {
        self._atlasFailed = true;
        console.warn("[CrowdField] 小人图集加载失败，已退回几何小人。", err);
        self.draw();
      });
  };

  /* ---------- 离屏预渲染：角色 × 帧 × 朝向 × 色调 ---------- */

  CrowdField.prototype._buildCache = function () {
    if (!this._atlas) return;
    var h = this.size;
    var scale = Math.min(this.dpr || 1, 2);
    var shadowPad = Math.max(1, h * 0.14);
    var spriteW = h * SPRITE_ASPECT;
    var spriteH = h + shadowPad;

    var cache = { size: h, scale: scale, w: spriteW, h: spriteH, shadow: shadowPad };

    // 激活小人可放大显示（如 Q3 第二段 21.5% 视觉强调），单独建一份大尺寸缓存
    var boost = Math.max(1, this.activeScale || 1);
    var activeCache = boost === 1
      ? cache
      : { size: h * boost, scale: scale, w: spriteW * boost, h: spriteH * boost, shadow: shadowPad * boost };

    var tints = {
      muted: { color: "#33454E", alpha: 0.62, bodyAlpha: 0.9, useCache: cache },
      active: { color: this.activeColor, alpha: 0.24, bodyAlpha: 1, useCache: activeCache }
    };
    var palettes = {};
    var self = this;
    Object.keys(tints).forEach(function (key) {
      palettes[key] = self._renderPalette(tints[key].useCache, tints[key]);
    });

    this._cache = cache;
    this._activeCache = activeCache;
    this._palettes = palettes;
  };

  CrowdField.prototype._renderPalette = function (cache, style) {
    var list = [];
    var cw = Math.max(1, Math.round(cache.w * cache.scale));
    var bodyH = Math.max(1, Math.round(cache.size * cache.scale));
    var ch = Math.max(bodyH + 1, Math.round(cache.h * cache.scale));

    for (var col = 0; col < ATLAS_COLS; col++) {
      for (var frame = 0; frame < ATLAS_ROWS; frame++) {
        for (var dir = 0; dir < 2; dir++) {
          var c = document.createElement("canvas");
          c.width = cw;
          c.height = ch;
          var g = c.getContext("2d");

          g.save();
          if (dir === 1) {
            g.translate(cw, 0);
            g.scale(-1, 1);
          }
          g.globalAlpha = style.bodyAlpha;
          g.drawImage(this._atlas, col * CELL_W, frame * CELL_H, CELL_W, CELL_H, 0, 0, cw, bodyH);
          g.restore();

          // 色调烘进精灵，主循环里不再逐人切换合成模式
          g.save();
          g.globalCompositeOperation = "source-atop";
          g.fillStyle = style.color;
          g.globalAlpha = style.alpha;
          g.fillRect(0, 0, cw, bodyH);
          g.restore();

          // 脚下投影
          g.save();
          g.fillStyle = "#000";
          g.globalAlpha = 0.26;
          g.beginPath();
          g.ellipse(cw / 2, bodyH + cache.shadow * cache.scale * 0.1, cw * 0.3, cache.shadow * cache.scale * 0.4, 0, 0, TAU);
          g.fill();
          g.restore();

          list[(col * ATLAS_ROWS + frame) * 2 + dir] = c;
        }
      }
    }
    return { list: list, w: cache.w, h: cache.h, size: cache.size };
  };

  CrowdField.prototype._ensureActivePalette = function (color) {
    if (!this._cache) return;
    var key = String(color).toLowerCase();
    if (this._palettes[key]) return;
    this._palettes[key] = this._renderPalette(this._activeCache || this._cache, {
      color: color,
      alpha: 0.24,
      bodyAlpha: 1
    });
  };

  CrowdField.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var w = rect.width || this.canvas.clientWidth || 640;
    var h = rect.height || this.canvas.clientHeight || 460;
    if (w < 40 || h < 40) return;
    var oldW = this.W;
    var oldH = this.H;

    this.W = w;
    this.H = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;

    // 以最坏分簇比例（第三题第二段 78.5% 在一侧）反推清晰且不越界的显示高度
    var perSide = Math.max(1, this.count * 0.45);
    var areaW = Math.max(80, w - Math.max(12, w * 0.03));
    var areaH = Math.max(60, (h - Math.max(30, h * 0.04)) / 2);
    var nextSize = 6;
    for (var cand = 42; cand >= 6; cand--) {
      var fitCols = Math.floor(areaW / (cand * SPRITE_ASPECT));
      var fitRows = Math.floor(areaH / cand);
      if (fitCols >= 1 && fitCols * fitRows >= perSide) {
        nextSize = cand;
        break;
      }
    }

    if (nextSize !== this.size) {
      this.size = nextSize;
      if (this._atlasReady) {
        this._buildCache();
        this._allocBuffers();
      }
    }

    if (oldW > 40 && oldH > 40) {
      var sx = this.W / oldW;
      var sy = this.H / oldH;
      this.people.forEach(function (p) {
        p.loc.x *= sx;
        p.loc.y *= sy;
        p.target.x *= sx;
        p.target.y *= sy;
        p.base.x *= sx;
        p.base.y *= sy;
      });
    }
  };

  CrowdField.prototype.buildPeople = function () {
    this.people = [];
    for (var i = 0; i < this.count; i++) {
      var fromAbove = i % 2 === 0;
      this.people.push({
        id: i,
        col: i % ATLAS_COLS,
        speedMult: 0.62 + hash(i + 21) * 0.85,
        response: 0.14 + hash(i + 37) * 0.14,
        swayPhase: hash(i + 43) * TAU,
        loc: {
          x: hash(i + 31) * this.W,
          y: fromAbove
            ? -this.size * 2 - hash(i + 41) * this.H * 0.8
            : this.H + this.size * 2 + hash(i + 41) * this.H * 0.8
        },
        vel: { x: 0, y: 0 },
        acc: { x: 0, y: 0 },
        target: { x: this.W / 2, y: this.H / 2 },
        base: { x: this.W / 2, y: this.H / 2 },
        frame: hash(i + 51) * 4,
        facing: hash(i + 3) < 0.5 ? 1 : 0,
        moving: false,
        active: false,
        actionDelay: 0,
        slotKey: 0
      });
    }
  };

  /* 紧凑网格：列距贴着身宽、行距略大于身高，整块在给定区域内居中 */
  CrowdField.prototype.groupLayout = function (items, x0, x1, y0, y1, effSize) {
    var n = items.length;
    if (!n) return;
    var size = effSize || this.size;
    var spriteW = size * SPRITE_ASPECT;
    var stepW = spriteW * 1.02;
    var stepH = size * 1.1;
    var areaW = Math.max(x1 - x0, spriteW);
    var areaH = Math.max(y1 - y0, size);

    var maxCols = Math.max(1, Math.floor(areaW / stepW));
    var cols = Math.min(maxCols, n);
    var rows = Math.ceil(n / cols);
    // 行数超出可用高度时压缩行距（允许轻微前后叠压），绝不溢出区域
    if (rows * stepH > areaH) stepH = areaH / rows;

    var blockW = (cols - 1) * stepW + spriteW;
    var blockH = (rows - 1) * stepH + size;
    var startX = x0 + (areaW - blockW) / 2 + spriteW / 2;
    var startY = y0 + (areaH - blockH) / 2 + size / 2;

    // 行内人数均分：每行 base 或 base+1 人，末行不会只剩零星几个
    var base = Math.floor(n / rows);
    var extra = n % rows;
    var cursor = 0;
    for (var row = 0; row < rows; row++) {
      var inRow = base + (row < extra ? 1 : 0);
      if (inRow <= 0) continue;
      var rowX = startX + ((cols - inRow) * stepW) / 2;
      var rowY = startY + row * stepH;
      for (var col = 0; col < inRow; col++) {
        var p = items[cursor++];
        p.base.x = rowX + col * stepW;
        p.base.y = rowY;
        p.target.x = p.base.x;
        p.target.y = p.base.y;
      }
    }
  };

  /* 乱序散布：把区域切格后随机分配，既没有重叠，也不是整齐队列 */
  CrowdField.prototype.scatterLayout = function (items, x0, x1, y0, y1) {
    var n = items.length;
    if (!n) return;
    var size = this.size;
    var spriteW = size * SPRITE_ASPECT;
    var areaW = Math.max(x1 - x0, spriteW);
    var areaH = Math.max(y1 - y0, size);
    var cellW = Math.max(spriteW * 1.04, 4);
    var cellH = Math.max(size * 1.02, 4);
    var cols = Math.max(1, Math.floor(areaW / cellW));
    var rows = Math.max(1, Math.floor(areaH / cellH));
    var total = cols * rows;
    var slots = new Int32Array(total);
    var i;
    for (i = 0; i < total; i++) slots[i] = i;

    // 固定种子的 Fisher-Yates：同一布局稳定可复现
    for (i = total - 1; i > 0; i--) {
      var j = Math.floor(hash(i + items[0].id * 13 + n) * (i + 1));
      var tmp = slots[i];
      slots[i] = slots[j];
      slots[j] = tmp;
    }

    var startX = x0 + (areaW - cols * cellW) / 2;
    var startY = y0 + (areaH - rows * cellH) / 2;

    items.forEach(function (p, idx) {
      var slot = slots[idx % total];
      var col = slot % cols;
      var row = Math.floor(slot / cols);
      var jx = (hash(p.id + 401) - 0.5) * cellW * 0.72;
      var jy = (hash(p.id + 409) - 0.5) * cellH * 0.6;
      p.target.x = startX + (col + 0.5) * cellW + jx;
      p.target.y = startY + (row + 0.5) * cellH + jy;
    });
  };

  CrowdField.prototype.layoutTargets = function () {
    var gap = Math.max(10, Math.round(this.H * 0.025));
    var boost = Math.max(1, this.activeScale || 1);
    var activeSize = this.size * boost;
    var topInset = Math.max(42, Math.round(activeSize * 1.6));
    var bottomInset = Math.max(10, Math.round(this.H * 0.03));
    var midY = this.H * 0.5;
    var people = this.people;
    if (!people.length) return;

    if (this.mode === "idle") {
      // 入场落点：所有人打散铺满整块画布，看不出左右/上下归属
      people.forEach(function (p) { p.active = false; });
      this.scatterLayout(people, 0, this.W, topInset, this.H - bottomInset);
      this.activeCount = 0;
      return;
    }

    // 作答后：命中比例的人聚到上半区并转强调色，其余退到下半区压暗
    var active = this._shuffled(people.slice(0, this.activeCount));
    var inactive = this._shuffled(people.slice(this.activeCount));
    active.forEach(function (p) { p.active = true; });
    inactive.forEach(function (p) { p.active = false; });
    this.groupLayout(active, 0, this.W, topInset, midY - gap / 2, activeSize);
    this.groupLayout(inactive, 0, this.W, midY + gap / 2, this.H - bottomInset);
  };

  CrowdField.prototype.updateBigNum = function (text, percent, color) {
    if (!this.bigNumEl) return;
    this.bigNumEl.classList.remove("show");
    var valEl = this.bigNumEl.querySelector(".bn-val");
    var subEl = this.bigNumEl.querySelector(".bn-sub");
    if (valEl && text != null) valEl.textContent = text;
    if (subEl) {
      subEl.textContent =
        Math.round((clamp(percent, 0, 100) / 100) * this.count) +
        " / " + this.count + " 个小人";
    }
    this.bigNumEl.classList.toggle("risk", isRiskColor(color));
  };

  CrowdField.prototype.reveal = function (percent, color, text, force, activeScale) {
    var activeCount = Math.round((clamp(percent, 0, 100) / 100) * this.count);
    var newBoost = activeScale != null ? Math.max(1, activeScale) : 1;
    var scaleChanged = newBoost !== this.activeScale;

    if (!force && !scaleChanged && (
      this.revealed &&
      this.activeCount === activeCount &&
      this.mode === "split" &&
      this.activePercent === percent
    )) {
      if (this.bigNumEl) this.bigNumEl.classList.add("show");
      return;
    }

    // 放大倍数变化时需重建激活调色板缓存
    if (scaleChanged) {
      this.activeScale = newBoost;
      if (this._atlasReady) this._buildCache();
    }

    this.revealed = true;
    this.mode = "split";
    this._interacted = true;
    this._revealSeq = (this._revealSeq || 0) + 1;
    this.activePercent = percent;
    this.activeCount = activeCount;
    this.activeColor = color || "#D4A017";
    if (this._atlasReady) this._ensureActivePalette(this.activeColor);
    this._staggerDeparture();
    this.layoutTargets();
    this.updateBigNum(text, percent, this.activeColor);
    this._stillFrames = 0;
    this.start();

    var self = this;
    clearTimeout(this._revealTimer);
    if (this.reduce) {
      this.snap();
      if (this.bigNumEl) this.bigNumEl.classList.add("show");
    } else {
      this._revealTimer = setTimeout(function () {
        if (self.bigNumEl) self.bigNumEl.classList.add("show");
      }, 1050);
    }
  };

  /* 每次换队形时重新洗牌站位并分配出发延迟：路径互相穿插，不会整排平移 */
  CrowdField.prototype._staggerDeparture = function () {
    var seed = (this._drawTick + (this._revealSeq || 0) * 137 + this.activeCount * 7) % 9973;
    this.people.forEach(function (p) {
      p.actionDelay = 0.05 + hash(p.id + seed) * 0.9;
      p.slotKey = hash(p.id * 3.7 + seed * 1.9);
    });
  };

  CrowdField.prototype._shuffled = function (items) {
    return items
      .slice()
      .sort(function (a, b) { return a.slotKey - b.slotKey; });
  };

  CrowdField.prototype.topSpeedOf = function (p) {
    return p.speedMult * this.size * 0.24;
  };

  /* 空间哈希：只与同格 / 下三格的人比较，避免 1000² 的全对全计算 */
  CrowdField.prototype._buildGrid = function () {
    var cell = this._gridSize;
    var cols = this._gridCols;
    var rows = this._gridRows;
    var head = this._gridHead;
    var next = this._gridNext;
    var people = this.people;
    head.fill(-1);

    for (var i = 0; i < people.length; i++) {
      var p = people[i];
      var gx = clamp(Math.floor(p.loc.x / cell), 0, cols - 1);
      var gy = clamp(Math.floor(p.loc.y / cell), 0, rows - 1);
      var key = (gy * cols + gx) | 0;
      next[i] = head[key];
      head[key] = i;
    }
  };

  CrowdField.prototype.update = function (dt) {
    var people = this.people;
    var n = people.length;
    var size = this.size;
    var halfW = size * SPRITE_ASPECT * 0.5;
    var halfH = size * 0.55;
    var cell = this._gridSize;
    var cols = this._gridCols;
    var rows = this._gridRows;
    var head = this._gridHead;
    var next = this._gridNext;
    var movingCount = 0;

    this._buildGrid();

    for (var i = 0; i < n; i++) {
      var p = people[i];
      var vx = p.vel.x;
      var vy = p.vel.y;
      var speed = Math.sqrt(vx * vx + vy * vy);
      var tx = p.target.x - p.loc.x;
      var ty = p.target.y - p.loc.y;
      var distance = Math.sqrt(tx * tx + ty * ty);
      var topSpeed = this.topSpeedOf(p);

      // 已站定：不再施加分离与抖动，保持队列纹丝不动
      // 阈值随人物尺寸缩放，避免大画布上 1.6px 过于敏感导致反复起停
      var stopDist = Math.max(1.6, size * 0.12);
      if (distance < stopDist && speed < topSpeed * 0.1) {
        p.loc.x = p.target.x;
        p.loc.y = p.target.y;
        p.vel.x = 0;
        p.vel.y = 0;
        p.moving = false;
        p.frame = 1;
        continue;
      }

      movingCount++;

      // 换队形时的个人延迟：有人先跑、有人等一下再动
      if (p.actionDelay > 0) {
        p.actionDelay -= dt / 60;
        p.moving = false;
        p.frame = 1;
        continue;
      }

      // 邻近分离只在奔跑阶段生效：快落位时撤销推挤，才能站得整齐
      var sepX = 0;
      var sepY = 0;
      var checks = 0;
      if (distance > size * 3) {
        var gx = clamp(Math.floor(p.loc.x / cell), 0, cols - 1);
        var gy = clamp(Math.floor(p.loc.y / cell), 0, rows - 1);
        for (var dy = 0; dy <= 1 && checks < 6; dy++) {
          var ny = gy + dy;
          if (ny >= rows) continue;
          for (var dx = -1; dx <= 1 && checks < 6; dx++) {
            var nx = gx + dx;
            if (nx < 0 || nx >= cols) continue;
            var key = (ny * cols + nx) | 0;
            var j = head[key];
            while (j !== -1 && checks < 6) {
              if (j !== i) {
                var o = people[j];
                var rx = p.loc.x - o.loc.x;
                var ry = p.loc.y - o.loc.y;
                if (Math.abs(rx) < halfW && Math.abs(ry) < halfH) {
                  sepX += rx;
                  sepY += ry;
                  checks++;
                }
              }
              j = next[j];
            }
          }
        }
      }
      if (checks) {
        p.acc.x += (sepX / checks / (size * 0.42)) * dt;
        p.acc.y += (sepY / checks / (size * 0.42)) * dt;
      }

      var desiredX = 0;
      var desiredY = 0;
      if (distance > 0.001) {
        var seekSpeed = distance < 90 ? Math.max(topSpeed * 0.32, (distance / 90) * topSpeed) : topSpeed;
        desiredX = (tx / distance) * seekSpeed;
        desiredY = (ty / distance) * seekSpeed;

        // 跑动时带一点侧向摆动，路线是弧线而不是整排平移
        var sway = Math.sin(p.frame * 0.9 + p.swayPhase) * seekSpeed * 0.34;
        desiredX += (-ty / distance) * sway;
        desiredY += (tx / distance) * sway;
      }

      // 接近目标时提高响应系数，确保快速收敛不抖动
      var resp = distance < size * 4 ? Math.max(p.response, 0.38) : p.response;
      p.vel.x += (desiredX - p.vel.x) * resp;
      p.vel.y += (desiredY - p.vel.y) * resp;

      // 距离目标尚远时加入轻微随机扰动：奔跑途中互相推挤，接近落位即收敛
      // 阈值从 size*2 放宽到 size*3.5，更早收敛，避免在目标附近抖动
      if (distance > size * 3.5) {
        p.vel.x += (Math.random() - 0.5) * size * 0.05;
        p.vel.y += (Math.random() - 0.5) * size * 0.05;
      }

      p.vel.x += p.acc.x;
      p.vel.y += p.acc.y;

      var v = Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y);
      if (v > topSpeed) {
        p.vel.x *= topSpeed / v;
        p.vel.y *= topSpeed / v;
      }

      p.loc.x += p.vel.x * dt;
      p.loc.y += p.vel.y * dt;
      p.acc.x = 0;
      p.acc.y = 0;

      p.loc.x = clamp(p.loc.x, size * 0.4, this.W - size * 0.4);
      p.loc.y = clamp(p.loc.y, -size * 10, this.H + size * 2);

      // 到点前最后半步直接落位；每个人的速度与响应不同，不会同时抵达
      // 阈值从 size*0.3 放大到 size*0.5，减少落位前的微振荡
      if (Math.abs(p.target.x - p.loc.x) < size * 0.5 && Math.abs(p.target.y - p.loc.y) < size * 0.5) {
        p.loc.x = p.target.x;
        p.loc.y = p.target.y;
        p.vel.x = 0;
        p.vel.y = 0;
        p.moving = false;
        p.frame = 1;
        continue;
      }

      var move = Math.abs(p.vel.x) + Math.abs(p.vel.y);
      p.moving = move > size * 0.06;
      if (Math.abs(p.vel.x) > Math.abs(p.vel.y) * 0.5) {
        p.facing = p.vel.x < 0 ? 1 : 0;
      }
      p.frame += (0.05 + clamp(move / (size * 0.9), 0, 1) * 0.16) * GAITS[p.col];
      if (p.frame > 1e6) p.frame %= 4;
    }

    // 全员站定后停止渲染，画面彻底静止
    if (movingCount === 0) this._stillFrames++;
    else this._stillFrames = 0;
  };

  CrowdField.prototype.snap = function () {
    this.people.forEach(function (p) {
      p.loc.x = p.target.x;
      p.loc.y = p.target.y;
      p.vel.x = 0;
      p.vel.y = 0;
      p.moving = false;
      p.frame = 1;
    });
    this.draw();
  };

  CrowdField.prototype.start = function () {
    if (this.reduce) {
      this.snap();
      return;
    }
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._loop);
  };

  CrowdField.prototype.stop = function () {
    this.running = false;
    cancelAnimationFrame(this._raf);
  };

  CrowdField.prototype.loop = function (now) {
    if (!this.visible) {
      this.running = false;
      return;
    }
    this._raf = requestAnimationFrame(this._loop);

    // 约 60fps 更新；1000 人的单帧开销已足够低
    var interval = this.count > 1600 ? 32 : 16;
    if (now - this._last < interval) return;

    var dt = clamp((now - this._last) / 16.667, 0.5, 2.4);
    this._last = now;

    this.update(dt);
    this.draw();

    // 连续静止约 0.7 秒后停帧，之后不再消耗 CPU
    if (this._stillFrames > 40) {
      this.stop();
    }
  };

  /* 按 y 分桶计数排序，O(n)，保证前排压后排的层次感 */
  CrowdField.prototype._sortByDepth = function () {
    var people = this.people;
    var n = people.length;
    var band = Math.max(6, this.size * 1.1);
    var bandCount = Math.ceil(this.H / band) + 4;
    if (!this._counts || this._counts.length !== bandCount) {
      this._counts = new Uint16Array(bandCount);
    }
    this._counts.fill(0);
    var i;
    for (i = 0; i < n; i++) {
      var b = clamp(Math.floor((people[i].loc.y + this.size * 6) / band), 0, bandCount - 1);
      this._counts[b]++;
    }
    var sum = 0;
    for (i = 0; i < bandCount; i++) {
      var c = this._counts[i];
      this._counts[i] = sum;
      sum += c;
    }
    var order = this._order;
    for (i = 0; i < n; i++) {
      var p = people[i];
      var bb = clamp(Math.floor((p.loc.y + this.size * 6) / band), 0, bandCount - 1);
      order[this._counts[bb]++] = i;
    }
    return order;
  };

  CrowdField.prototype.draw = function () {
    var ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.W, this.H);

    var n = this.people.length;
    if (!n) return;

    // 深度排序每两帧刷新一次，顺序变化极慢
    if (!this._order || (this._drawTick++ & 1) === 0) {
      this._sortByDepth();
    }
    var order = this._order;

    if (!this._atlasReady) {
      if (this._atlasFailed) {
        for (var f = 0; f < n; f++) this.drawFallback(this.people[order[f]]);
      }
      return;
    }

    var palettes = this._palettes;
    var activePal = palettes[String(this.activeColor).toLowerCase()] || palettes.active;
    var mutedPal = palettes.muted;
    var cache = this._cache;
    if (!cache) return;

    var W = this.W;
    var H = this.H;
    var cullH = Math.max(cache.h, activePal.h);
    var cullW = Math.max(cache.w, activePal.w);

    for (var k = 0; k < n; k++) {
      var p = this.people[order[k]];
      if (p.loc.y < -cullH || p.loc.y > H + 12 || p.loc.x < -cullW || p.loc.x > W + cullW) {
        continue;
      }
      var pal = p.active ? activePal : mutedPal;
      var frame = p.moving ? Math.floor(p.frame) % ATLAS_ROWS : 1;
      var img = pal.list[(p.col * ATLAS_ROWS + frame) * 2 + p.facing];
      if (!img) continue;
      ctx.drawImage(img, p.loc.x - pal.w / 2, p.loc.y - pal.size, pal.w, pal.h);
    }
  };

  // 图集缺失时的几何小人兜底
  CrowdField.prototype.drawFallback = function (p) {
    var ctx = this.ctx;
    if (p.loc.y < -this.size * 3 || p.loc.y > this.H + 12) return;
    var s = this.size;
    var h = s * 2;
    ctx.globalAlpha = p.active ? 1 : 0.4;
    ctx.fillStyle = p.active ? this.activeColor : "#8B989D";
    ctx.beginPath();
    ctx.arc(p.loc.x, p.loc.y - h * 0.82, s * 0.34, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(p.loc.x - s * 0.36, p.loc.y - h * 0.66, s * 0.72, h * 0.66, s * 0.18);
    } else {
      ctx.rect(p.loc.x - s * 0.36, p.loc.y - h * 0.66, s * 0.72, h * 0.66);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  CrowdField.prototype.getStats = function () {
    return {
      count: this.count,
      size: this.size,
      mode: this.mode,
      activeCount: this.activeCount,
      running: this.running,
      visible: this.visible,
      stillFrames: this._stillFrames,
      atlasReady: this._atlasReady,
      dpr: this.dpr
    };
  };

  CrowdField.prototype.destroy = function () {
    this.stop();
    if (this._io) this._io.disconnect();
    if (this._ro) this._ro.disconnect();
    clearTimeout(this._revealTimer);
  };

  window.CrowdField = CrowdField;
})();
