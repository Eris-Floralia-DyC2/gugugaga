(() => {
  const canvas = document.querySelector('#particles'),
    ctx = canvas.getContext('2d'),
    img = document.querySelector('#background'),
    frozen = document.querySelector('#frozen-background');
  let config = {},
    perf = { paused: false, eco: false, fps: 30 },
    pageHidden = document.hidden,
    raf = 0,
    last = 0,
    points = [],
    width = 1,
    height = 1,
    current = '',
    pausedImage = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const paused = () => perf.paused || pageHidden;
  function size() {
    const r = canvas.getBoundingClientRect();
    width = r.width;
    height = r.height;
    const d = Math.min(devicePixelRatio, 2);
    canvas.width = width * d;
    canvas.height = height * d;
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  new ResizeObserver(size).observe(canvas);
  size();
  function freezeImage() {
    if (!img.getAttribute('src') || !img.complete || !img.naturalWidth) return;
    frozen.width = img.naturalWidth;
    frozen.height = img.naturalHeight;
    try {
      frozen.getContext('2d').drawImage(img, 0, 0);
      frozen.style.display = 'block';
      img.removeAttribute('src');
      pausedImage = true;
    } catch {}
  }
  function background() {
    const name = config.background || '';
    const url = name ? 'wsapp://app/backgrounds/' + encodeURIComponent(name) : '';
    if (current !== url) {
      current = url;
      pausedImage = false;
      img.removeAttribute('src');
      frozen.style.display = 'none';
      if (url) img.src = url;
    }
    const animated = /\.(gif|apng)$/i.test(name);
    if (animated && (paused() || perf.eco || !config.animations || reduced.matches)) {
      freezeImage();
    } else if (pausedImage) {
      frozen.style.display = 'none';
      if (current) img.src = current;
      pausedImage = false;
    }
  }
  img.addEventListener('load', background);
  img.addEventListener('error', () => {
    img.removeAttribute('src');
    current = '';
    WS.toast('背景资源缺失或格式无效，请重新导入。', true);
  });
  function frame(now) {
    raf = 0;
    if (paused() || !config.animations || !config.particles || reduced.matches) {
      ctx.clearRect(0, 0, width, height);
      return;
    }
    const fps = Math.max(1, Math.min(config.fps || 30, perf.eco ? 12 : 60));
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / fps) return;
    const dt = Math.min(100, now - last || 33) / 16.67;
    last = now;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = config.particleColor || '#a8eed2';
    ctx.globalAlpha = (config.particleOpacity || 0) * Math.min(1, config.particleIntensity || 0);
    const count = Math.round((config.particleCount || 0) * (perf.eco ? 0.35 : 1));
    while (points.length < count)
      points.push({
        x: Math.random(),
        y: Math.random(),
        r: 0.5 + Math.random(),
        phase: Math.random() * 6,
      });
    if (points.length > count) points.length = count;
    for (const p of points) {
      p.y -= 0.00035 * (config.particleSpeed || 0) * dt;
      p.x += Math.sin(now / 4000 + p.phase) * 0.00008 * dt;
      if (p.y < -0.02) {
        p.y = 1.02;
        p.x = Math.random();
      }
      ctx.beginPath();
      ctx.arc(p.x * width, p.y * height, (config.particleSize || 1) * p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    canvas.style.filter = `brightness(${config.particleBrightness || 1})`;
  }
  function restart() {
    cancelAnimationFrame(raf);
    raf = 0;
    background();
    if (!paused()) raf = requestAnimationFrame(frame);
  }
  reduced.addEventListener('change', restart);
  document.addEventListener('visibilitychange', () => {
    pageHidden = document.hidden;
    restart();
  });
  WS.effects = {
    configure(c) {
      const changed = JSON.stringify(c) !== JSON.stringify(config);
      config = c;
      if (changed) restart();
    },
    setPerformance(p) {
      perf = p;
      restart();
    },
    status() {
      return {
        ...perf,
        paused: paused(),
        pausedImage,
        pageHidden,
        background: current,
        particles: points.length,
      };
    },
  };
})();
