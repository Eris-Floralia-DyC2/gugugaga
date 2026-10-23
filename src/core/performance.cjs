function performancePolicy({
  hidden = false,
  covered = false,
  battery = false,
  locked = false,
  animations = true,
  mode = 'auto',
  fps = 30,
}) {
  const paused = hidden || covered || locked || !animations;
  const eco = battery || mode === 'eco';
  return {
    paused,
    eco,
    battery,
    covered,
    fps: paused ? 0 : eco ? Math.min(12, fps) : fps,
    reason: hidden
      ? '已收起'
      : locked
        ? '屏幕锁定'
        : covered
          ? '完全遮挡'
          : !animations
            ? '动画关闭'
            : battery
              ? '电池省电'
              : eco
                ? '省电模式'
                : '正常',
  };
}
module.exports = { performancePolicy };
