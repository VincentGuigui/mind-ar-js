// White-border corner-accuracy AUDIT tool (diagnostic, not a pass/fail test).
// Run: node testing/white-border-corner-audit.mjs   (after `npm run build`; needs playwright-core)
// Detects the quad on testing/targets/white_frame_postcard.jpg, then writes to the scratchpad/output dir:
//   corner-{TL,TR,BR,BL}.png  — 6x magnified crops with a red crosshair at the DETECTED corner
//                                and a 5px grid, to measure the offset to the TRUE corner by eye
//   card-mask-overlay.png     — the analysis-resolution white mask (red) + detected quad (green)
//                                over the photo, showing threshold bleed/undershoot
// Used to diagnose the quad-outside-the-card bias (background bleed at TR, outer-envelope offset).
import {createServer} from 'http';import {readFile} from 'fs/promises';import {extname,join} from 'path';
const ROOT='/home/user/mind-ar-js';const OUT='/tmp/claude-0/-home-user/8556d254-986b-5898-885a-7c76a94e7a5e/scratchpad';
const {chromium}=await import('playwright-core');
const MIME={'.html':'text/html','.js':'application/javascript','.jpg':'image/jpeg'};
const srv=createServer(async(q,r)=>{try{const d=await readFile(join(ROOT,q.url.split('?')[0]));r.writeHead(200,{'Content-Type':MIME[extname(q.url)]||'application/octet-stream'});r.end(d);}catch(e){r.writeHead(404);r.end();}});
await new Promise(r=>srv.listen(8143,r));
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',headless:true});
const p=await b.newPage();p.on('pageerror',e=>console.log('ERR',e.message));
await p.goto('http://localhost:8143/testing/white-border-corner-audit.html');
await p.waitForFunction('window.__ready===true',null,{timeout:15000});
const res=await p.evaluate(()=>window.__setup('white_frame_postcard.jpg',0.62));
console.log('detected corners:',JSON.stringify(res.corners));
const names=['TL','TR','BR','BL'];
for(let i=0;i<4;i++){
  const c=res.corners[i];
  await p.evaluate(([x,y])=>window.__crop(x,y,80,6),[c.x,c.y]);
  await p.locator('#crop').screenshot({path:`${OUT}/corner-${names[i]}.png`});
}
// mask overlay of the whole card region
await p.evaluate(()=>window.__maskOverlay(330,110,420,320,2));
await p.locator('#maskov').screenshot({path:`${OUT}/card-mask-overlay.png`});
await b.close();srv.close();
console.log('crops + mask overlay saved');
