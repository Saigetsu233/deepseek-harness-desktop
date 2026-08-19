'use strict';

/**
 * 把 DeepSeek 鲸鱼 SVG 栅格化为应用图标 build/icon.png（512x512）。
 * 用 Electron 渲染进程 + Canvas 2D 的 Path2D 直接绘制 SVG 路径，
 * 不依赖 SVG 图片解码（结果确定）。
 * 用法：electron scripts/rasterize-icon.js
 *
 * 输出：白色圆角方块 + 品牌蓝鲸鱼（与 DeepSeek 官方图标同款配色）。
 * 颜色：--dsw-static-deepseek-500 = rgb(65,118,230) = #4176E6
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'favicon-src.svg');
const OUT = path.join(ROOT, 'build', 'icon.png');

const OUT_SIZE = 512;
const BRAND_BLUE = '#4176E6';

app.whenReady().then(async () => {
  try {
    const raw = fs.readFileSync(SRC, 'utf8');
    const m = /<path[^>]*d="([^"]+)"/.exec(raw);
    if (!m) throw new Error(`未在 ${SRC} 中找到 path 元素`);
    const whalePath = m[1];

    const win = new BrowserWindow({ width: 32, height: 32, show: false, frame: false });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><body></body>'));

    const js = `(() => {
      const d = ${JSON.stringify(whalePath)};
      const S = ${OUT_SIZE};
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      // 白底圆角方块（圆角约 20%）
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(S * 0.04, S * 0.04, S * 0.92, S * 0.92, S * 0.195);
      ctx.fill();
      // 品牌蓝鲸鱼：原 SVG 为 50x50 坐标系，中心约 (25.3, 25.2)，
      // 放大到约占图标宽 63% 并居中
      const scale = S * 0.63 / 48.3;
      ctx.save();
      ctx.translate(S / 2 - 25.3 * scale, S / 2 - 25.2 * scale);
      ctx.scale(scale, scale);
      ctx.fillStyle = '${BRAND_BLUE}';
      ctx.fill(new Path2D(d));
      ctx.restore();
      return c.toDataURL('image/png');
    })()`;

    const dataUrl = await win.webContents.executeJavaScript(js);
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(OUT, buf);
    console.log(`已生成 ${OUT} (${OUT_SIZE}x${OUT_SIZE}，${buf.length} 字节)`);
    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error('生成图标失败:', err);
    app.exit(1);
  }
});
