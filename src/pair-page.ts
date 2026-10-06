export const pairPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link WhatsApp · Sirfbazar</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f5f2;color:#18352c;font:16px/1.55 system-ui,sans-serif}main{max-width:720px;margin:48px auto;padding:0 22px}h1{font-size:34px;line-height:1.15;margin:12px 0}h2{font-size:19px;margin:0 0 12px}.eyebrow{font-size:12px;letter-spacing:.14em;font-weight:700;color:#507262}p{margin:12px 0;color:#52635d}.card{background:white;border:1px solid #d9e2dc;border-radius:16px;padding:24px;margin:22px 0;box-shadow:0 3px 18px #18352c05}label{display:block;margin:16px 0 6px;font-weight:600}input{width:100%;padding:12px;border:1px solid #b6c7bd;border-radius:8px;font:inherit}button{border:0;border-radius:8px;padding:12px 18px;background:#176342;color:white;font:600 15px system-ui;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button.secondary{background:#eaf0ec;color:#244836}button.danger{background:#fff0eb;color:#a13d27;border:1px solid #edc1b4}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:16px}.badge{display:inline-block;padding:5px 12px;background:#eef2ee;border-radius:99px;font-size:14px;font-weight:650}.badge.connected{background:#dcf6e5;color:#176342}.notice{padding:12px 16px;border-left:3px solid #bb8031;background:#fff6e7;font-size:14px}#error{color:#a13d27;white-space:pre-wrap}#qr-box{text-align:center}#qr{display:block;width:min(100%,330px);height:auto;margin:16px auto;background:white}#code{font:700 28px/1.6 ui-monospace,monospace;letter-spacing:.15em;text-align:center;overflow-wrap:anywhere}.small{font-size:13px;color:#697a71}hr{border:0;border-top:1px solid #e2e9e4;margin:24px 0}[hidden]{display:none!important}a{color:#176342}button:focus-visible,input:focus-visible{outline:3px solid #95bdb0;outline-offset:3px}
</style><script src="/pair/app.js" defer></script></head><body><main>
<div class="eyebrow">SIRFBAZAR · WHATSAPP</div><h1>Link your sender account</h1>
<p>Connect WhatsApp, check its status, or start a new login here. No Oracle login is needed.</p>
<p id="transport" class="notice" hidden>This page is using HTTP. Your admin key and pairing QR travel unencrypted. Use an encrypted connection for private access.</p>
<form id="login" class="card"><h2>Unlock pairing controls</h2><label for="admin-key">Admin key</label>
<input id="admin-key" type="password" autocomplete="off" spellcheck="false" required placeholder="Enter ADMIN_KEY">
<div class="row"><button type="submit" id="unlock">Unlock</button></div><p class="small">Use ADMIN_KEY, not the sending key. It stays in this tab’s memory and is cleared when you lock or close the page.</p></form>
<p id="error" role="alert" aria-live="polite"></p>
<section id="controls" class="card" hidden>
<div class="row" style="margin-top:0"><h2 style="margin:0;flex:1">Connection</h2><span id="status" class="badge" role="status">Checking…</span><button id="lock" class="secondary">Lock</button></div>
<p id="guidance"></p><p id="updated" class="small"></p>
<div id="qr-box" hidden><img id="qr" alt="Scan this QR in WhatsApp Linked devices"><p>On your phone: <strong>WhatsApp → Linked devices → Link a device</strong>.</p></div>
<div class="row"><button id="refresh" class="secondary">Refresh status / QR</button></div>
<div id="phone-pairing" hidden><hr><h2>Or link with a phone number</h2><p>Enter the sender’s WhatsApp number, including the country code.</p>
<form id="phone-form"><label for="phone">Sender phone number</label><input id="phone" type="tel" autocomplete="tel" placeholder="+923001234567" required pattern="[+][1-9][0-9]{6,14}"><div class="row"><button id="get-code" type="submit">Get pairing code</button></div></form>
<p id="code"></p><p id="code-help" hidden>In WhatsApp’s Linked devices screen, choose the phone-number linking option and enter this code.</p></div>
<hr><h2>Start a new login</h2><p>Reset only when you need to relink or change accounts. This clears the API’s saved login and stops sending until you pair again. Remove the old device entry from WhatsApp’s Linked devices if it remains listed.</p>
<button id="reset" class="danger">Reset login and get a new QR</button>
</section><p class="small">Linking does not send a message. Normal restarts and deployments keep your login.</p>
</main></body></html>`;

export const pairScript = String.raw`
'use strict';
const el = id => document.getElementById(id);
let key = '', timer, qrUrl, lastQr = 0, busy = false, version = 0;
el('transport').hidden = location.protocol === 'https:';
const labels = {connected:'Connected',awaiting_pairing:'Ready to pair',connecting:'Connecting',reconnecting:'Reconnecting',logged_out:'Logged out',error:'Needs attention',stopped:'Stopped'};
const guidance = {connected:'WhatsApp is ready to send. You do not need to pair again.',awaiting_pairing:'Scan the QR below, or request a pairing code.',connecting:'Waiting for WhatsApp. This page updates automatically.',reconnecting:'The API is reconnecting. Wait before resetting your login.',logged_out:'The saved login was logged out. Reset the login below to get a fresh QR.',error:'WhatsApp needs a new login or operator attention. You can reset the login below.',stopped:'The connection is stopped. Reset the login to start pairing.'};
function clearQr(){ if(qrUrl) URL.revokeObjectURL(qrUrl); qrUrl = undefined; el('qr').removeAttribute('src'); el('qr-box').hidden = true; }
function clearCode(){el('code').textContent='';el('code-help').hidden=true;}
function lock(){version++;key='';clearTimeout(timer);clearQr();clearCode();el('admin-key').value='';el('controls').hidden=true;el('login').hidden=false;}
async function api(path, options={}){
  const response = await fetch(path,{...options,cache:'no-store',credentials:'omit',headers:{...(options.body?{'Content-Type':'application/json'}:{}),Authorization:'Bearer '+key},signal:AbortSignal.timeout(10000)});
  if(!response.ok){
    let message='Request failed ('+response.status+').';
    try{message=(await response.json()).error?.message || message;}catch{}
    if(response.status===401){lock();message='The admin key was not accepted. Enter ADMIN_KEY and try again.';}
    throw new Error(message);
  }
  return response;
}
function displayError(error){el('error').textContent=error.name==='TimeoutError'?'The request timed out. Refresh status before trying again.':error.message;}
async function update(forceQr=false){
  if(!key)return;
  const current=version;
  const response=await api('/admin/session');const {state}=await response.json();
  if(current!==version)return;
  el('status').textContent=labels[state]||state;el('status').className='badge '+(state==='connected'?'connected':'');
  el('guidance').textContent=guidance[state]||'Check the connection again in a moment.';
  el('updated').textContent='Checked '+new Date().toLocaleTimeString();
  el('controls').hidden=false;el('login').hidden=true;el('phone-pairing').hidden=state!=='awaiting_pairing';
  if(state!=='awaiting_pairing'){clearQr();clearCode();return;}
  if(forceQr)clearCode();
  if(!el('code').textContent && (forceQr || !qrUrl || Date.now()-lastQr>=15000)){
    const qr=await api('/admin/qr');const blob=await qr.blob();
    if(current!==version)return;
    clearQr();qrUrl=URL.createObjectURL(blob);el('qr').src=qrUrl;el('qr-box').hidden=false;lastQr=Date.now();
  }
}
function schedule(){clearTimeout(timer);if(key)timer=setTimeout(async()=>{if(busy){schedule();return;}busy=true;try{await update();el('error').textContent='';}catch(error){displayError(error);}finally{busy=false;schedule();}},5000);}
async function action(fn){if(busy)return;busy=true;clearTimeout(timer);el('error').textContent='';document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(error){displayError(error);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);schedule();}}
el('login').addEventListener('submit',event=>{event.preventDefault();action(async()=>{key=el('admin-key').value.trim();version++;await update(true);el('admin-key').value='';});});
el('lock').addEventListener('click',()=>{lock();el('error').textContent='';});
el('refresh').addEventListener('click',()=>action(()=>update(true)));
el('phone-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const current=version;const response=await api('/admin/pairing-code',{method:'POST',body:JSON.stringify({phone:el('phone').value.trim()})});const result=await response.json();if(current!==version)return;clearQr();el('code').textContent=result.code;el('code-help').hidden=false;});});
el('reset').addEventListener('click',()=>{if(!confirm('Clear this API’s current WhatsApp login? Message sending will stop until you pair again.'))return;action(async()=>{await api('/admin/reset',{method:'POST',body:JSON.stringify({confirm:'RESET_WHATSAPP_SESSION'})});clearQr();clearCode();lastQr=0;await update(true);});});
window.addEventListener('pagehide',lock);
`;
