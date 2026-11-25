/**
 * Q1 spike (THROWAWAY, never imported by the product): do localStorage and IndexedDB of the
 * bundled origin wire-bundled://app persist across a full app restart?
 * Valid design: a FIXED userData dir (Q1_UD) shared by two separate processes.
 *   Q1_MODE=write  -> writes values, exits
 *   Q1_MODE=read   -> fresh process, ONLY reads (never writes) and asserts the values
 * A control run with a different Q1_UD must NOT find the values.
 * Runner: spike/run-q1-persistence.sh. (--no-sandbox there is only for the root CI container.)
 * The previous version used mkdtempSync (a new dir per run) and wrote+read in the same process,
 * so it could not prove persistence; that version is replaced.
 */
const { app, BrowserWindow, protocol } = require('electron');
const ud = process.env.Q1_UD; const mode = process.env.Q1_MODE; // write | read
app.setPath('userData', ud);
protocol.registerSchemesAsPrivileged([{ scheme: 'wire-bundled', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.whenReady().then(async () => {
  protocol.handle('wire-bundled', () => new Response('<!doctype html><title>q1</title>', { headers: { 'content-type': 'text/html' } }));
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await win.loadURL('wire-bundled://app/index.html');
  const r = await win.webContents.executeJavaScript(`(async()=>{
    const mode=${JSON.stringify(mode)}; const LS='persist-ls-value-42', IDB='persist-idb-value-42';
    const db = await new Promise((res,rej)=>{const q=indexedDB.open('q1db',1); q.onupgradeneeded=()=>q.result.createObjectStore('s'); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error);});
    if(mode==='write'){ localStorage.setItem('k',LS); await new Promise((res,rej)=>{const t=db.transaction('s','readwrite'); t.objectStore('s').put(IDB,'k'); t.oncomplete=res; t.onerror=()=>rej(t.error);}); return {mode, origin:location.origin, wrote:true}; }
    const idb = await new Promise((res,rej)=>{const t=db.transaction('s','readonly'); const g=t.objectStore('s').get('k'); g.onsuccess=()=>res(g.result); g.onerror=()=>rej(g.error);});
    return {mode, origin:location.origin, localStorage: localStorage.getItem('k'), indexedDB: idb, lsOk: localStorage.getItem('k')===LS, idbOk: idb===IDB}; })()`);
  console.log('[q1]', JSON.stringify(r));
  await new Promise(r=>setTimeout(r,800)); app.exit(0);
});
