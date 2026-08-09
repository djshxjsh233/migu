# iptv_alive — 咪咕央视直播源（CF Worker 云端自动刷新）

**TVBox 直播源（每 30 分钟自动更新 token）：**

```
https://gitee.com/zy2zy7/iptv_alive/raw/master/live.txt
https://gitee.com/zy2zy7/iptv_alive/raw/master/live.m3u
```

## 原理
- Cloudflare Worker `migu-test` 每 30 分钟定时触发
- 免登录 MD5 签名调咪咕 playurl 接口，拿 28 个央视频道（含 CCTV-5/5+）真实流地址
- 写回本仓库 live.txt / live.m3u

## 部署（wrangler）
```
cd worker
wrangler secret put GITEE_TOKEN
wrangler deploy
```

## 频道
央视频道 22 个 + CGTN 6 个，含 CCTV-5/5+（网页端放不了的体育频道）
