#!/usr/bin/env node
/**
 * CF Pages/VLESS 节点自动优选 IP 生成订阅脚本（青龙标准格式）
 *
 * 用途:给 wo13468733.pages.dev 这类 CF Pages VLESS 节点加优选IP,使其更快
 * 原理:客户端用更快CF IP直连,SNI/Host保持原pages域名,CF边缘按SNI路由到你的Pages
 *
 * 部署:青龙面板 新建任务 填本文件路径, cron: 30 * * * * (每30分钟)
 * 输出:sub.txt (订阅内容) / sub_base64.txt (base64版) / alive_ips.txt (可达IP)
 */

// ============ 节点配置(改成你自己的) ============
const NODE_UUID = "d02e93f3-ad1d-4f9e-b5ee-a0cfef167349"; // 你的UUID
const NODE_HOST = "wo13468733.pages.dev";              // 你的节点域名(SNI/Host)
const NODE_PORT = 443;
const WS_PATH   = "/zrAe0sQ8JsdT0QHd?ed=2560";          // 你的WS路径
const REMARK_PREFIX = "BestIP";                         // 节点备注前缀

// ============ 优选参数 ============
const TOP_N = 10;             // 输出多少个优选节点
const TCP_TIMEOUT_MS = 2500;  // 单IP连接超时
const SCAN_N = 600;           // 扫描多少个IP(调大更准但更慢)
const FS = require('fs');

// CF 核心IP段(可扩展)
const SEGS = [
  "104.16.0.0/13","104.24.0.0/14","172.64.0.0/13","162.158.0.0/15",
  "162.159.0.0/16","198.41.128.0/17","173.245.48.0/20","141.101.64.0/18",
  "188.114.96.0/20","190.93.240.0/20","197.234.240.0/22"
];

function ipInSegs(ip) {
  // 简单段匹配(仅处理前缀),精简实现
  const p = ip.split('.').map(Number);
  const v = ((p[0]<<24)|(p[1]<<16)|(p[2]<<8)|p[3]) >>> 0;
  for (const seg of SEGS) {
    const [base, bits] = seg.split('/');
    const bp = base.split('.').map(Number);
    const bv = ((bp[0]<<24)|(bp[1]<<16)|(bp[2]<<8)|bp[3]) >>> 0;
    const mask = bits == 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    if ((v & mask) == (bv & mask)) return true;
  }
  return false;
}

// 生成候选IP(直接从CF段内生成,保证都在可用段)
function genCandidates() {
  const cands = new Set();
  const rnd = require('crypto').randomBytes(4).readUInt32BE(0);
  let seed = rnd || 12345;
  const myRnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  // 优先选常用可达段加速命中
  const HOT = [  // Cloudflare 官方全部IPv4段(常用段优先多采样)
    "104.16.0.0/13",  // 最常用,权重最高
    "104.24.0.0/14",
    "172.64.0.0/13",  // 常用
    "162.158.0.0/15",
    "162.159.0.0/16",
    "198.41.128.0/17",
    "173.245.48.0/20",
    "141.101.64.0/18",
    "188.114.96.0/20",
    "190.93.240.0/20",
    "197.234.240.0/22",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "108.162.192.0/18",
    "131.0.72.0/22"
  ];
  // 对最常用的几个段加大采样权重(重复放入提高概率)
  const WEIGHTED = [...HOT, 
    "104.16.0.0/13","104.16.0.0/13","104.16.0.0/13",  // 104.16 三倍权重
    "172.64.0.0/13","172.64.0.0/13",                   // 172.64 双倍
    "104.24.0.0/14","162.158.0.0/15",                  // 常用段各加一次
  ];
  let guard = 0;
  while (cands.size < SCAN_N && guard < SCAN_N * 200) {
    guard++;
    const seg = WEIGHTED[myRnd() % WEIGHTED.length];
    const [base, bits] = seg.split('/');
    const bp = base.split('.').map(Number);
    let bv = BigInt(((bp[0]<<24)|(bp[1]<<16)|(bp[2]<<8)|bp[3]) >>> 0);
    const hostbits = 32 - Number(bits);
    const host = hostbits >= 24 ? BigInt(myRnd()) :
                 hostbits >= 16 ? BigInt(myRnd() & 0xffff) :
                 hostbits >= 8  ? BigInt(myRnd() & 0xff) : 0n;
    const ipInt = bv | host;
    cands.add(`${Number((ipInt>>24n)&255n)}.${Number((ipInt>>16n)&255n)}.${Number((ipInt>>8n)&255n)}.${Number(ipInt&255n)}`);
  }
  return [...cands];
}

// TCP 443 连接延迟测试
function checkTCP(ip) {
  return new Promise(resolve => {
    const start = Date.now();
    try {
      const sock = require('net').connect(NODE_PORT, ip);
      sock.setTimeout(TCP_TIMEOUT_MS);
      sock.once('connect', () => { sock.end(); resolve({ ip, ms: Date.now() - start }); });
      sock.once('timeout', () => { sock.destroy(); resolve({ ip, ms: -1 }); });
      sock.once('error', () => { sock.destroy(); resolve({ ip, ms: -1 }); });
      setTimeout(() => { try { sock.destroy(); } catch(e){} }, TCP_TIMEOUT_MS + 500);
    } catch(e) { resolve({ ip, ms: -1 }); }
  });
}

// 关键: 验证 IP 能否用 pages SNI 完成 TLS 握手(TLSv1.3 ClientHello) 路由到节点
function checkSNI(ip) {
  return new Promise(resolve => {
    const tls = require('tls');
    const start = Date.now();
    const sock = tls.connect({
      host: NODE_HOST, port: NODE_PORT, servername: NODE_HOST,
      socket: (() => {
        const net = require('net');
        const raw = net.connect(NODE_PORT, ip);
        return raw;
      })(),
      rejectUnauthorized: false, minVersion: 'TLSv1.2'
    });
    const done = ok => { try { sock.destroy(); } catch(e){} resolve(ok); };
    const to = setTimeout(() => done({ ip, ok:false, ms:-1, err:'timeout' }), TCP_TIMEOUT_MS);
    sock.once('secureConnect', () => {
      clearTimeout(to);
      const ms = Date.now() - start;
      const cert = sock.getPeerCertificate();
      done({ ip, ok: true, ms, cn: cert?.subject?.CN || '' });
    });
    sock.once('error', e => { clearTimeout(to); done({ ip, ok:false, ms:-1, err:e.message }); });
  });
}

// 全链路验证: 用curl --resolve 指定IP+SNI访问pages, 判断HTTP状态(200才真正路由成功)
// curl比node https / 内嵌python更可靠(与真实客户端行为一致)
function curlVerify(ip) {
  return new Promise(resolve => {
    const { exec } = require('child_process');
    const t0 = Date.now();
    exec(`curl -s -o /dev/null -w "%{http_code}" --max-time 4 --resolve "${NODE_HOST}:443:${ip}" "https://${NODE_HOST}/"`, 
      (err, stdout) => {
        if (err) return resolve({ ip, ok: false, ms: Date.now()-t0, http: -1 });
        const code = parseInt(String(stdout).trim() || "0");
        resolve({ ip, ok: code === 200, ms: Date.now()-t0, http: code });
      });
  });
}

// ============ 订阅推送配置(推送到Gitee,国内直连快) ============
const GITEE_TOKEN = "你的GITEE_TOKEN"; // 你的Gitee token
const GITEE_REPO = "zy2zy7/iptv_alive";                // 你的仓库
const GITEE_FILE = "vless_sub.txt";                    // 订阅文件名(明文vless)
const GITEE_BASE = "master";                           // 默认分支
// 订阅URL: https://gitee.com/zy2zy7/iptv_alive/raw/master/vless_sub.txt

// 推送订阅内容到Gitee(用原生fetch,可靠)
async function pushToGitee(txt) {
  const apiUrl = `https://gitee.com/api/v5/repos/${GITEE_REPO}/contents/${GITEE_FILE}`;
  const b64 = Buffer.from(txt).toString('base64');
  try {
    // 1. 取现有文件sha(若存在则更新,不存在则创建)
    let sha = '';
    try {
      const g = await (await fetch(`${apiUrl}?access_token=${GITEE_TOKEN}`)).json();
      sha = g.sha || '';
    } catch(_) {}
    // 2. 提交
    const body = {
      access_token: GITEE_TOKEN,
      content: b64,
      message: `auto update subscription ${new Date().toISOString().slice(0,19)}`,
      branch: GITEE_BASE
    };
    if (sha) body.sha = sha;
    const r = await fetch(apiUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const rd = await r.json();
    if (rd.content && rd.content.sha) return true;
    console.log(`[Gitee] 返回: ${JSON.stringify(rd).slice(0,200)}`);
    return false;
  } catch (e) {
    console.log(`[Gitee] 异常: ${e.message}`);
    return false;
  }
}
// ============ 订阅推送配置(GitHub双保险) ============
const GH_TOKEN = "你的GITHUB_TOKEN"; // GitHub token
const GH_REPO = "djshxjsh233/migu";
const GH_FILE = "vless_sub.txt";
const GH_BASE = "main";
// 订阅URL: https://raw.githubusercontent.com/djshxjsh233/migu/main/vless_sub.txt

// 推送订阅内容到GitHub
async function pushToGitHub(txt) {
  const apiUrl = `https://api.github.com/repos/${GH_REPO}/contents/${GH_FILE}`;
  const b64 = Buffer.from(txt).toString('base64');
  try {
    // 1. 取现有文件sha
    let sha = '';
    try {
      const g = await (await fetch(apiUrl, { headers: { 'Authorization': `token ${GH_TOKEN}` } })).json();
      sha = g.sha || '';
    } catch(_) {}
    // 2. 提交
    const body = {
      message: `auto update subscription ${new Date().toISOString().slice(0,19)}`,
      content: b64,
      branch: GH_BASE
    };
    if (sha) body.sha = sha;
    const r = await fetch(apiUrl, { method: 'PUT', headers: { 'Authorization': `token ${GH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const rd = await r.json();
    if (rd.content && rd.content.sha) return true;
    console.log(`[GitHub] 返回: ${JSON.stringify(rd).slice(0,200)}`);
    return false;
  } catch (e) {
    console.log(`[GitHub] 异常: ${e.message}`);
    return false;
  }
}
function makeVless(ip, idx) {
  const remark = encodeURIComponent(`${REMARK_PREFIX} ${idx}@${ip}`);
  const path = encodeURIComponent(WS_PATH);
  return `vless://${NODE_UUID}@${ip}:${NODE_PORT}?encryption=none&security=tls&sni=${NODE_HOST}&fp=chrome&type=ws&host=${NODE_HOST}&path=${path}#${remark}`;
}

async function main() {
  const t0 = Date.now();
  console.log(`[优选] 扫描 ${SCAN_N} 个CF IP, 测试 TCP:${NODE_PORT} 延迟...`);
  const cands = genCandidates();
  console.log(`[优选] 已生成 ${cands.length} 个候选IP`);

  const results = [];
  const { performance } = require('perf_hooks');
  // 分批并发(每批50) - 先TCP连通测试
  const BATCH = 50;
  const tcpAlive = [];
  for (let i = 0; i < cands.length; i += BATCH) {
    const batch = cands.slice(i, i + BATCH);
    const rs = await Promise.all(batch.map(checkTCP));
    tcpAlive.push(...rs.filter(r => r.ms > 0));
  }
  tcpAlive.sort((a,b) => a.ms - b.ms);
  // 对最快的IP直接做TLS+SNI+HTTP验证(verifyNode一步完成,只保留200可通过的)
  const toVerify = tcpAlive.slice(0, Math.min(120, tcpAlive.length));
  console.log(`[优选] TCP可用 ${tcpAlive.length} 个, 对前缀 ${toVerify.length} 个做TLS+SNI+HTTP验证...`);
  const verifiedOk = [];
  for (let i = 0; i < toVerify.length; i += 10) {
    const batch = toVerify.slice(i, i + 10);
    const rs = await Promise.all(batch.map(r => curlVerify(r.ip)));
    const okItems = rs.filter(r => r.ok);
    for (const r of okItems) verifiedOk.push({ ip: r.ip, ms: r.ms, http: r.http });
  }
  verifiedOk.sort((a,b) => a.ms - b.ms);
  let alive;
  if (verifiedOk.length > 0) {
    alive = verifiedOk.map(r => ({ ip:r.ip, ms:r.ms }));
    console.log(`[优选] TLS+SNI+HTTP(200)验证成功 ${alive.length} 个, 最快: ${alive[0]?.ip}(${alive[0]?.ms}ms)`);
  } else {
    // 兜底: 优先拿TCP最快的(即使HTTP可能403,留给客户端测试) 但尽量给可用的
    alive = tcpAlive.slice(0, TOP_N).map(r => ({ ip:r.ip, ms:r.ms }));
    console.log(`[优选] 无HTTP200, 退回TCP最快(${alive.length}个)`);
  }

  // 输出订阅
  const top = alive.slice(0, TOP_N);
  const subLines = top.map((r,i) => makeVless(r.ip, i+1));
  const subText = subLines.join('\n');

  FS.writeFileSync('/tmp/sub.txt', subText);
  const b64Sub = Buffer.from(subText).toString('base64');
  FS.writeFileSync('/tmp/sub_base64.txt', b64Sub);
  FS.writeFileSync('/tmp/alive_ips.txt', alive.map(r => `${r.ip} ${r.ms}`).join('\n'));

  console.log(`[优选] 生成订阅 ${top.length} 条, 花费 ${(Date.now()-t0)/1000}s`);
  console.log(`[优选] 最快节点: ${subLines[0]||'无'}`);
  console.log(`[优选] 文件: /tmp/sub_base64.txt (base64订阅,可直接导入v2rayN)`);

  // 推送到 Gitee + GitHub 生成固定订阅URL(双保险)
  const giteeUrl = `https://gitee.com/${GITEE_REPO}/raw/${GITEE_BASE}/${GITEE_FILE}`;
  const ghUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BASE}/${GH_FILE}`;
  try {
    const pg = await pushToGitee(b64Sub);
    console.log(pg ? `[优选] ✅ 已推Gitee: ${giteeUrl}` : `[优选] ⚠️ Gitee推送失败: ${giteeUrl}`);
  } catch (e) { console.log(`[优选] ⚠️ Gitee异常: ${e.message}`); }
  try {
    const ph = await pushToGitHub(b64Sub);
    console.log(ph ? `[优选] ✅ 已推GitHub(经镜像可能有缓存延迟,非实时): ${ghUrl}` : `[优选] ⚠️ GitHub推送失败: ${ghUrl}`);
  } catch (e) { console.log(`[优选] ⚠️ GitHub异常: ${e.message}`); }
  console.log(`[优选] 📌 【实时】订阅URL(推荐,v2rayN/Clash填这个):`);
  console.log(`[优选]    Gitee: ${giteeUrl}`);
  console.log(`[优选]    GitHub-ghfast实时加速: https://ghfast.top/https://raw.githubusercontent.com/${GH_REPO}/${GH_BASE}/${GH_FILE}`);
  console.log(`[优选]    GitHub-gh-proxy实时加速: https://gh-proxy.com/https://raw.githubusercontent.com/${GH_REPO}/${GH_BASE}/${GH_FILE}`);
  console.log(`[优选] 📌 GitHub原始备用(有缓存/可能被墙): ${ghUrl}`);
  console.log(`[优选] 完成`);
}

main().catch(e => console.error('ERR', e));
