/**
 * Q2 spike (THROWAWAY, never imported by the product): can a page on the privileged
 * custom scheme wire-bundled://app reach a REAL server on a NON-loopback IP via fetch and WebSocket?
 * Controls: loopback targets from the same page, and the same four tests from a plain
 * http://<non-loopback-ip> origin. Also logs the Origin header Electron really sends (Q3).
 * Run via spike/run-q2-real-server.sh (starts the real `node server.js`, bound to 0.0.0.0).
 * --no-sandbox is used by the runner only because the CI container runs as root; spike only.
 */
const { app, BrowserWindow, protocol, session } = require('electron');
const IP = process.env.NLIP, PORT = process.env.SPORT;
protocol.registerSchemesAsPrivileged([{ scheme: 'wire-bundled', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const TESTS = `(async () => {
  const out = { origin: location.origin, isSecureContext: window.isSecureContext, subtle: !!(crypto && crypto.subtle), tests: [] };
  const wsT = (name, url) => new Promise(res => { let done=false; const fin=(r)=>{ if(!done){done=true; res({name,url,...r});} };
    try { const w = new WebSocket(url); w.onopen=()=>{fin({ok:true,event:'open'}); w.close();}; w.onerror=()=>fin({ok:false,event:'error'}); w.onclose=(e)=>fin({ok:false,event:'close code='+e.code}); setTimeout(()=>fin({ok:false,event:'timeout'}),6000);} catch(e){fin({ok:false,event:'throw '+e.message});} });
  const fT = async (name,url)=>{ try{ const r=await fetch(url); return {name,url,ok:r.ok,status:r.status}; }catch(e){ return {name,url,ok:false,error:String(e)}; } };
  const NL='${IP}', P='${PORT}';
  out.tests.push(await fT('fetch non-loopback','http://'+NL+':'+P+'/api/version'));
  out.tests.push(await wsT('ws non-loopback','ws://'+NL+':'+P+'/socket.io/?EIO=4&transport=websocket'));
  out.tests.push(await fT('fetch loopback','http://127.0.0.1:'+P+'/api/version'));
  out.tests.push(await wsT('ws loopback','ws://127.0.0.1:'+P+'/socket.io/?EIO=4&transport=websocket'));
  return out; })()`;
async function run(win, label, url) {
  win.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['http://*/api/version*'] }, (d, cb) => { console.log(`[origin-sent:${label}] ${d.url} Origin=${d.requestHeaders['Origin'] || '(none)'}`); cb({ requestHeaders: d.requestHeaders }); });
  win.webContents.on('console-message', (e, level, msg) => console.log(`[console:${label}]`, msg));
  win.webContents.session.webRequest.onErrorOccurred((d) => console.log(`[net-error:${label}]`, d.method, d.url, d.error));
  await win.loadURL(url);
  const r = await win.webContents.executeJavaScript(TESTS);
  console.log(`RESULT ${label} ` + JSON.stringify(r, null, 1));
}
app.whenReady().then(async () => {
  protocol.handle('wire-bundled', () => new Response('<!doctype html><title>t</title>', { headers: { 'content-type': 'text/html' } }));
  try {
    await run(new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } }), 'BUNDLED(wire-bundled://app)', 'wire-bundled://app/index.html');
    await run(new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } }), 'CONTROL(http-nonloopback-origin)', `http://${IP}:${PORT}/login.html`);
  } catch (e) { console.log('ERR', e); }
  app.exit(0);
});
