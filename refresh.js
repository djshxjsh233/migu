#!/usr/bin/env node
/**
 * 咪咕央视直播源自动刷新引擎
 * 原理: 咪咕直播 m3u8 带短时 token(约4小时有效), 每次播放需实时换取。
 *       本脚本用无头 Chromium 打开咪咕官方详情页, 由官方页面自动完成加密换 token,
 *       抓取带最新 token 的直播 m3u8 地址, 生成 TVBox 可用的直播源 JSON。
 *
 * 用法: node refresh.js                    # 全量刷新(默认)
 *       node refresh.js --only=cctv1       # 只刷指定频道(channels.json 里的 channel 值)
 *       node refresh.js --timeout=75000    # 单频道超时
 *
 * 输出: live.txt / live.m3u (自动覆盖)
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer-core');

const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const CHANNELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'channels.json'), 'utf8'));
const OUT_TXT = path.join(__dirname, process.env.OUT_TXT || 'live.txt');
const OUT_M3U = path.join(__dirname, process.env.OUT_M3U || 'live.m3u');
const BASE_URL = 'https://m.miguvideo.com/m/liveDetail/{pID}?channelId=10010001005';
const UA = 'Mozilla/5.0 (Linux; Android 13; M2006J10C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

async function grabM3u8(page, ch, timeoutMs) {
  const hit = [];
  page.on('request', r => { const u = r.url(); if (/\.m3u8/.test(u)) hit.push(u); });
  const url = BASE_URL.replace('{pID}', ch.pID);
  await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded', referer: 'https://m.miguvideo.com/' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    // video.currentSrc 到直播态(非广告mp4)即采纳
    const vs = await page.evaluate(() => { const v = document.querySelector('video'); return v ? (v.currentSrc || '') : ''; }).catch(() => '');
    if (vs && /\.m3u8/.test(vs)) return vs;
    // 网络请求兜底: gslb/hlsztemg 的 index.m3u8
    const picked = hit.find(u => /(hlsztemg|h5live\.gslb)/.test(u) && u.includes('/index.m3u8')) || '';
    if (picked) return picked;
  }
  return '';
}

// gslb 返回的是文本URL(非标准m3u8), TVBox播放器无法解析。
// 需再请求一次, 解析出真实CDN的标准m3u8地址再提供。
async function resolveRealCdn(url) {
  if (/^https:\/\/hlsztemg/.test(url)) return url;   // 已经是真实CDN
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://m.miguvideo.com/' },
      signal: AbortSignal.timeout(15000)
    });
    const text = await resp.text();
    const line = text.split('\n').map(s => s.trim()).find(s => s.startsWith('http'));
    if (line && /hlsztemg/i.test(line)) return line;
    if (line && /^https?:/.test(line)) return line;    // 其它真实源地址兜底
  } catch (e) { /* 忽略, 保留原URL */ }
  return url;
}

(async () => {
  console.log('🏁 咪咕央视直播源刷新', new Date().toLocaleString());
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const onlyCh = onlyArg ? onlyArg.split('=')[1] : null;
  const tArg = process.argv.find(a => a.startsWith('--timeout='));
  const to = tArg ? parseInt(tArg.split('=')[1], 10) : 75000;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions']
  });

  const groups = {};
  for (const [grp, list] of Object.entries(CHANNELS)) {
    groups[grp] = groups[grp] || [];
    for (const ch of list) {
      if (onlyCh && ch.channel !== onlyCh) continue;
      process.stdout.write(`  [${grp}] ${ch.name} … `);
      try {
        const page = await browser.newPage();
        await page.setUserAgent(UA);
        const url = await grabM3u8(page, ch, to);
        await page.close().catch(() => {});
        if (url) {
          const real = await resolveRealCdn(url);
          groups[grp].push({ name: ch.name, url: real });
          console.log('✅' + (real !== url ? ' (已解析真实CDN)' : ''));
        } else console.log('❌ 超时');
      } catch (e) {
        console.log('❌', String(e).slice(0, 100));
      }
    }
  }
  await browser.close().catch(() => {});

  const ok = Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length));
  const total = Object.values(ok).reduce((a, v) => a + v.length, 0);

  // —— .txt (TVBox 传统格式: 组名,#genre# + 台名,url) ——
  const txtPath = path.join(__dirname, process.env.OUT_TXT || 'live.txt');
  const lines = [];
  for (const [g, list] of Object.entries(ok)) { lines.push(`${g},#genre#`); for (const c of list) lines.push(`${c.name},${c.url}`); }
  fs.writeFileSync(txtPath, lines.join('\n'));

  // —— .m3u ——
  const m3uPath = path.join(__dirname, process.env.OUT_M3U || 'live.m3u');
  const m3u = ['#EXTM3U'];
  for (const [g, list] of Object.entries(ok)) { for (const c of list) { m3u.push(`#EXTINF:-1 group-title="${g}" tvg-name="${c.name}",${c.name}`); m3u.push(c.url); } }
  fs.writeFileSync(m3uPath, m3u.join('\n'));

  console.log(`\n✅ 已写入 live.txt / live.m3u，共 ${total} 个频道有效`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });