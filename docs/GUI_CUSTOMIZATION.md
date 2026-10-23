# HTML/CSS 主题教程

1. 右键小组件 → 打开主题目录，或管理空间 → 外观与动画 → 打开主题文件夹。
2. 默认目录为 EXE 同级 `data/themes/default/`。先复制成 `my-theme/` 再修改，以便回退。
3. 在设置选择 `my-theme`，保存。编辑该目录的 widget.html / style.css，保存约250ms后自动刷新；连续保存会合并。

文件夹名只接受1–60个字母、数字、下划线或短横线。每个主题必须同时含 widget.html 和 style.css。默认主题只在首次缺失时从公共资源创建，更新 EXE 不覆盖现有主题。

## 模板接口 v1

HTML 中下面每种 data-slot 必须恰好一次：

```html
<article class="widget-shell">
  <header class="widget-header">
    <div class="brand">WS<span>MY THEME</span></div>
    <nav data-slot="toolbar"></nav>
  </header>
  <section data-slot="date"></section>
  <section data-slot="progress"></section>
  <section data-slot="quick-add"></section>
  <main class="task-scroll">
    <section data-slot="today"></section>
    <section data-slot="history"></section>
    <section data-slot="future"></section>
    <section data-slot="completed"></section>
  </main>
  <footer data-slot="status"></footer>
</article>
```

可移动插槽和包装容器，不要在插槽内写固定任务。应用用 textContent 插入任务文本并自行绑定按钮。`.widget-header` 空白处作为拖动手柄；缺少这个类则用日期区拖动。不要把整个输入区设置为拖动区域。

允许 article/header/footer/main/section/nav/div/span/h1/h2/p，以及 class、data-slot、aria-label。脚本、iframe、事件属性等会被清洗。缺少必要插槽时保留最近有效布局；首次加载损坏则回退内置模板。

## 常用 CSS

```css
.widget-shell {
  padding: 22px;
  gap: 18px;
}
.date-block h1 {
  font-size: 30px;
}
.task-list {
  gap: 9px;
}
.task-row {
  border-radius: 12px;
  padding: 13px;
}
.completed .task-title {
  opacity: 0.65;
}
```

CSS 变量包括 `--text`、`--accent`、`--card-opacity`、`--content-opacity`、`--radius`、`--border-width`、`--border-color`、`--bg-opacity`、`--brightness`、`--blur`、`--bg-fit`、`--bg-scale`、`--bg-position`、`--overlay`、`--filter`、`--shadow`。

覆盖顺序：内置基础 CSS → 外部主题 CSS → GUI 设置产生的根元素变量。自定义选择器可使用这些变量，也可以写固定值覆盖具体组件；GUI 不会改写 style.css。不要使用 `!important` 隐藏必要按钮，避免破坏可用性。

外部 CSS 禁止 @import、url()、脚本表达式和反斜线转义。背景应通过 GUI 导入 data/backgrounds，或在配置中指定该目录内的简单文件名，防止主题联网或读取任意文件。首版不提供外部 JS 插件。

## 背景与动态效果

GUI 导入 PNG/JPG/JPEG/WebP/GIF/APNG，最大25MB。导入后复制成唯一文件名，移动便携目录仍可用。可以切换 cover/contain、缩放、位置、透明度、亮度和模糊。窗口圆角裁剪所有效果，粒子不抢鼠标。

粒子在内置 Canvas 2D 渲染，可调整数量、大小、速度、颜色、透明度、亮度、强度和帧率。新算法请修改 src/renderer/effects.js 并重新构建。低功耗时 GIF/APNG 采用静态首帧，恢复时可能从头播放。

## 错误恢复

先修复外部文件并保存。找不到 CSS/HTML 或 CSS 越过限制时使用内置资源；损坏 HTML 的插槽校验失败时保留最近有效布局。若改到无法操作，可从托盘打开管理窗口切回 default。删除或改名自己的主题前先选择其他主题，应用不会自动删除你的任务数据。
