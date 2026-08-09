// 咪咕720p匿名取流 (develop202/migu_video 算法完整复现)
import crypto from 'node:crypto';
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
function getDateString(d){ return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`; }

// 正确的 getddCalcu720p: 首尾字符交错
function getddCalcu720p(puData, programId) {
  if (!puData) return "";
  const keys = "cdabyzwxkl";
  let dd = [];
  for (let i = 0; i < puData.length / 2; i++) {
    dd.push(puData[puData.length - i - 1]);
    dd.push(puData[i]);
    switch (i) {
      case 1: dd.push("v"); break;
      case 2: dd.push(keys[parseInt(getDateString(new Date())[2])]); break;
      case 3: dd.push(keys[programId[6]]); break;
      case 4: dd.push("a"); break;
    }
  }
  return dd.join("");
}
function getddCalcuURL720p(puDataURL, programId) {
  if (!puDataURL || !programId) return "";
  const puData = puDataURL.split("&puData=")[1];
  const ddCalcu = getddCalcu720p(puData, programId);
  return `${puDataURL}&ddCalcu=${ddCalcu}&sv=10004&ct=android`;
}

async function getAndroidURL720p(pid) {
  const timestramp = Date.now().toString();
  const appVersion = "2600034600";
  const appVer8 = appVersion.slice(0, 8);
  const salt = String(Math.floor(Math.random() * 1000000)).padStart(6, '0') + '25';
  const md = md5(timestramp + pid + appVer8);
  const suffix = "2cac4f2c6c3346a5b34e085725ef7e33migu" + salt.slice(0, 4);
  const sign = md5(md + suffix);
  const headers = {
    'AppVersion': appVersion,
    'TerminalId': 'android',
    'X-UP-CLIENT-CHANNEL-ID': appVersion + '-99000-201600010010028',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36'
  };
  const baseURL = "https://play.miguvideo.com/playurl/v1/play/playurl";
  const params = `?sign=${sign}&rateType=3&contId=${pid}&timestamp=${timestramp}&salt=${salt}&flvEnable=true&super4k=true&h265N=true&4kvivid=true&2Kvivid=true&vivid=2`;
  const resp = await fetch(baseURL + params, { headers });
  const respData = await resp.json();
  const url = respData.body && respData.body.urlInfo ? respData.body.urlInfo.url : null;
  if (!url) { console.log("无url. 响应:", JSON.stringify(respData).slice(0, 400)); return null; }
  console.log("RAWURL=" + url);
  const enc = getddCalcuURL720p(url, pid);
  console.log("ENCODED=" + enc);
  return enc;
}





async function pushToGitee(ok) {
  const g = process.env.GITEE_TOKEN || "8e16d76b0ade2b34743bc96c4b603c59";
  const lines = [];
  for (const [grp, list] of Object.entries(ok)) {
    lines.push(grp + ",#genre#");
    for (const c of list) lines.push(c.name + "," + c.url);
  }
  const content = lines.join("\n");
  const resp = await fetch("https://gitee.com/api/v5/repos/zy2zy7/iptv_alive/contents/live.txt?access_token=" + g, {
    method: "GET"
  });
  let sha = null;
  try { const r = await resp.json(); if (r && r.sha) sha = r.sha; } catch(e){}
  const b64 = btoa(unescape(encodeURIComponent(content)));
  const body = { access_token: g, content: b64, message: "auto " + new Date().toISOString() };
  if (sha) body.sha = sha;
  const up = await fetch("https://gitee.com/api/v5/repos/zy2zy7/iptv_alive/contents/live.txt?access_token=" + g, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const r2 = await up.json();
  console.log("Gitee push:", up.status, r2 && r2.content ? "OK sha=" + r2.content.sha.slice(0,8) : JSON.stringify(r2).slice(0,200));
  return up.status;
}

export default {
  async scheduled(event, env, ctx) {
    const ok = {};
    for (const [grp, list] of Object.entries(CHANNELS)) {
      ok[grp] = ok[grp] || [];
      for (const [name, pid] of list) {
        try {
          const url = await getAndroidURL720p(pid);
          if (url) { ok[grp].push({ name, url }); console.log("OK " + name); }
          else console.log("FAIL " + name);
        } catch(e) { console.log("ERR " + name + " " + e.message); }
        await new Promise(r => setTimeout(r, 600));
      }
    }
    const valid = Object.fromEntries(Object.entries(ok).filter(([,v]) => v.length));
    await pushToGitee(valid);
  },
  async fetch(request, env, ctx) {
    const ok = {};
    for (const [grp, list] of Object.entries(CHANNELS)) {
      ok[grp] = ok[grp] || [];
      for (const [name, pid] of list) {
        try { const url = await getAndroidURL720p(pid); if (url) ok[grp].push({name, url}); } catch(e){}
        await new Promise(r => setTimeout(r, 400));
      }
    }
    const st = await pushToGitee(Object.fromEntries(Object.entries(ok).filter(([,v])=>v.length)));
    return new Response("pushed " + st, { status: 200 });
  }
};
