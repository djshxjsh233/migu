# 咪咕央视直播源 → TVBox 自动更新仓库

把**咪咕视频**的央视直播自动换成 TVBox 能用的直播源，GitHub Actions 每 30 分钟自动刷新 token，长期有效。

## 原理

央视官方直播源带短时 token（约 4 小时失效），不能做成静态 m3u8。
本仓库用无头 Chromium **自动打开咪咕官方详情页**（页面自己完成加密换 token），抓取带最新 token 的 m3u8，生成 TVBox 直播源。
GitHub Actions 定时（每 30 分钟）执行，永久自动更新。

## 使用（TVBox 里填源地址）

**TVBox 直播间 → 配置 → 填入以下任一地址：**

```
https://raw.githubusercontent.com/djshxjsh233/migu/main/live.txt
```

> 或 M3U 版（新壳普遍支持）：

```
https://raw.githubusercontent.com/djshxjsh233/migu/main/live.m3u
```

两种格式内容完全一致（同一批 URL），按播放器支持的选。
首次更新需等 1 次 Actions 跑完（<30 分钟）。可到仓库 **Actions** 页手动点 `Run workflow` 立即刷新。

## 国内加速镜像（GitHub 直连慢/失败时用）

GitHub raw 在国内经常连不上，用这些镜像地址替代（内容相同，实时回源无缓存）：

```
# 镜像1: gh-proxy.com（实时回源，推荐）
https://gh-proxy.com/https://raw.githubusercontent.com/djshxjsh233/migu/main/live.txt
https://gh-proxy.com/https://raw.githubusercontent.com/djshxjsh233/migu/main/live.m3u

# 镜像2: jsdelivr CDN（国内快，但可能缓存旧数据）
https://cdn.jsdelivr.net/gh/djshxjsh233/migu@main/live.txt
https://cdn.jsdelivr.net/gh/djshxjsh233/migu@main/live.m3u

# 镜像3: gcore.jsdelivr（jsdelivr 备用）
https://gcore.jsdelivr.net/gh/djshxjsh233/migu@main/live.txt
```

> 提示：token 约 4 小时过期，**优先用实时镜像（gh-proxy）**；jsdelivr 有缓存可能播放失败时换回 gh-proxy 或 raw。

## 本地运行（可选）

```bash
npm install            # 需先装系统 chromium
node refresh.js        # 全量刷新，生成 live.txt / live.m3u
```

## 频道覆盖

央视频道：CCTV1-15, CCTV17, CCTV4欧/美 + CGTN 全语种 + 老故事/发现之旅/中学生，共 28 个频道。
> 说明：
> - 咪咕网页端仅开放央视直播，卫视/地方/体育/熊猫等栏目需 App 内鉴权，未收录
> - 咪咕该页面未收录 CCTV16 奥林匹克
> - CCTV5/5+ 体育频道 H5 无免登录播放，偶发超时/不可用

## 本地环境要求

- Node ≥ 18
- Chromium（Ubuntu: `sudo apt install chromium`；macOS/Win 装 Chrome 后设置 `CHROME_PATH`）

```bash
CHROME_PATH=/usr/bin/google-chrome node refresh.js
```