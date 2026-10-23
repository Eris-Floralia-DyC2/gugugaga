function clampBounds(bounds, area) {
  const width = Math.min(Math.max(300, bounds.width || 400), area.width),
    height = Math.min(Math.max(300, bounds.height || 580), area.height);
  return {
    x: Math.round(Math.min(Math.max(bounds.x ?? area.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y ?? area.y, area.y), area.y + area.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}
function defaultBounds(area, width = 400, height = 580) {
  return clampBounds(
    { x: area.x + area.width - width - 24, y: area.y + area.height - height - 24, width, height },
    area,
  );
}
function snapBounds(b, a, threshold = 16) {
  const n = { ...b };
  if (Math.abs(b.x - a.x) < threshold) n.x = a.x;
  if (Math.abs(b.y - a.y) < threshold) n.y = a.y;
  if (Math.abs(b.x + b.width - a.x - a.width) < threshold) n.x = a.x + a.width - b.width;
  if (Math.abs(b.y + b.height - a.y - a.height) < threshold) n.y = a.y + a.height - b.height;
  return n;
}
function remember(b, d) {
  const a = d.workArea;
  return {
    displayId: String(d.id),
    x: b.x - a.x,
    y: b.y - a.y,
    width: b.width,
    height: b.height,
    ratioX: a.width > b.width ? (b.x - a.x) / (a.width - b.width) : 0,
    ratioY: a.height > b.height ? (b.y - a.y) / (a.height - b.height) : 0,
    areaWidth: a.width,
    areaHeight: a.height,
    scaleFactor: d.scaleFactor,
  };
}
function restore(state, displays, primary) {
  const d = displays.find((x) => String(x.id) === state?.displayId) || primary;
  const a = d.workArea;
  if (!state || String(d.id) !== state.displayId)
    return defaultBounds(a, state?.width, state?.height);
  const x =
    a.width === state.areaWidth
      ? a.x + state.x
      : a.x + (a.width - state.width) * (state.ratioX || 0);
  const y =
    a.height === state.areaHeight
      ? a.y + state.y
      : a.y + (a.height - state.height) * (state.ratioY || 0);
  return clampBounds({ ...state, x, y }, a);
}
module.exports = { clampBounds, defaultBounds, snapBounds, remember, restore };
