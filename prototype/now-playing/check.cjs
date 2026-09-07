/* プロトタイプの自動検証。ヘッドレス Chrome で実際に描画し、配置・状態遷移・
 * キーボード操作・コントラスト・RAF の負荷を確かめてスクリーンショットを残す。
 *
 * playwright はこのプロジェクトの依存ではないので、場所を環境変数で渡す。
 *   YTM_PLAYWRIGHT=<playwrightのパス> node prototype/now-playing/check.cjs
 * 出力先の既定は private-docs/phase5-verification/（git 追跡外）。
 * YTM_OUT で変えられる。
 *
 * 見た目を変えたら必ずこれを通すこと。目視だけでは、
 * 「アイコンは差し替わったが再生アイコンが一度も表示されない」類の不具合を見逃す。 */
const { chromium } = require(process.env.YTM_PLAYWRIGHT || 'playwright');
const fs = require('fs');const assert=require('node:assert/strict');
const dir=process.env.YTM_OUT || require('node:path').resolve(__dirname,'../../private-docs/phase5-verification');
require('fs').mkdirSync(dir,{recursive:true});
const base=require('node:url').pathToFileURL(require('node:path').resolve(__dirname,'index.html')).href;
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
 const errors=[],requests=[],checks=[]; page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url())});
 await page.addInitScript(()=>{window.frameCosts=[];const original=requestAnimationFrame;window.requestAnimationFrame=fn=>original.call(window,now=>{const start=performance.now();fn(now);if(window.frameCosts.length<1200)window.frameCosts.push(performance.now()-start)});window.actions=[];document.addEventListener('player-action',e=>window.actions.push(e.detail));});
 async function load(state='playing',capture=true){await page.goto(base+`?state=${state}${capture?'&capture=1':''}`);await page.waitForFunction(()=>document.querySelector('#smoke').dataset.renderer);await page.waitForTimeout(150);}
 const check=(name,ok)=>{assert.ok(ok,name);checks.push(name)};
 // aria-label ではなく「実際に描かれているか」を見る。SVG化のとき、aria は正しいのに
 // 再生アイコンが一度も表示されない不具合が検証をすり抜けた実績がある。
 const painted=()=>page.evaluate(()=>['pause-icon','play-icon','spinner'].filter(id=>{
   const el=document.getElementById(id); if(!el) return false;
   const r=el.getBoundingClientRect(); const st=getComputedStyle(el);
   return r.width>0 && r.height>0 && st.display!=='none' && st.visibility!=='hidden' && Number(st.opacity)>0;
 }));
 const paintedIs=async(name,expected)=>{const got=await painted();
   check(`${name}: 描画されているのは ${expected} だけ`, got.length===1 && got[0]===expected);};
 await load();check('file:// WebGL renders',await page.locator('#smoke').getAttribute('data-renderer')==='webgl');
 await page.screenshot({path:dir+'/1920-final.png'});
 for (const size of [{width:1440,height:900},{width:1100,height:700}]) {
  await page.setViewportSize(size);await page.waitForTimeout(150);
  const dims=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('.transport button,.view-switch button')].map(e=>e.getBoundingClientRect().toJSON()),art:document.querySelector('.artwork-wrap').getBoundingClientRect().toJSON()}));
  check(`${size.width}: no horizontal overflow and controls visible`, !dims.overflow && dims.buttons.every(b=>b.x>=0&&b.y>=0&&b.right<=size.width&&b.bottom<=size.height));
  await page.screenshot({path:dir+`/${size.width}-normal.png`});
 }
 await page.setViewportSize({width:1440,height:900});
 await paintedIs('再生中','pause-icon');
 await page.getByRole('button',{name:'一時停止',exact:true}).click();check('pause button changes',await page.getByRole('button',{name:'再生',exact:true}).count()===1);
 await paintedIs('一時停止','play-icon');
 await page.getByRole('button',{name:'再生',exact:true}).press('Enter');check('keyboard play',await page.getByRole('button',{name:'一時停止',exact:true}).count()===1);
 await paintedIs('再生へ戻した後','pause-icon');
 for(const mode of ['全曲','1曲','オフ']) {await page.locator('#repeat').click();check(`repeat ${mode}`,await page.locator('#repeat').getAttribute('aria-label')===`リピート：${mode}`);}
 await page.locator('#shuffle').click();check('shuffle toggle',await page.locator('#shuffle').getAttribute('aria-pressed')==='true');
 await page.locator('#repeat').click();await page.locator('#repeat').click();
 check('リピート1のバッジが描画される',await page.evaluate(()=>{const b=document.querySelector('.repeat-one');const r=b.getBoundingClientRect();return !b.hidden&&r.width>0&&r.height>0}));
 await page.screenshot({path:dir+'/1440-shuffle-repeat-one.png'});
 await page.locator('#repeat').click();await page.locator('#shuffle').click();
 await page.locator('#seek').focus();const before=Number(await page.locator('#seek').inputValue());await page.keyboard.press('ArrowRight');check('seek integer keyboard step',Number(await page.locator('#seek').inputValue())===before+1);
 check('seek event emitted once',await page.evaluate(()=>window.actions.filter(a=>a.type==='seek').length)===1);
 await page.locator('#more').click();await page.locator('#volume').focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');check('volume 0–100 integer scale',await page.locator('#volume').inputValue()==='1');
 await page.locator('#mute').click();check('mute independent',await page.locator('#mute').getAttribute('aria-pressed')==='true');await page.locator('#mute').click();check('unmute preserves volume',await page.locator('#volume').inputValue()==='1');
 await page.keyboard.press('Escape');check('dialog returns focus',await page.evaluate(()=>document.activeElement.id)==='more');
 await page.locator('#queue-view').click();check('queue focus moves to item',await page.evaluate(()=>document.activeElement.classList.contains('queue-item')));
 await page.locator('.queue-item').nth(1).click();check('queue selects warm track',await page.locator('#title').textContent()==='夜明けまであと少しだけ、この街の音を聴いていたい');
 check('palette source updated',await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--art-primary').trim())==='#a34b38');
 await page.keyboard.press('Escape');check('queue Escape restores trigger focus',await page.evaluate(()=>document.activeElement.id)==='queue-view');
 await page.setViewportSize({width:1100,height:700});await load('long');
 await page.locator('#more').click();await page.locator('#translation').check();await page.keyboard.press('Escape');await page.waitForTimeout(150);
 check('long translated lyrics wrap within panel',await page.locator('.lyric-line').evaluateAll(es=>es.every(e=>e.scrollWidth<=e.clientWidth+1)));
 check('full long metadata accessible',await page.locator('#title').getAttribute('title')===await page.locator('#title').textContent());
 await page.screenshot({path:dir+'/1100-long-translated.png'});
 await page.setViewportSize({width:1440,height:900});
 for(const state of ['paused','loading','lyrics-loading','no-lyrics','lyrics-error','translation','neutral']) {
  await load(state);await page.screenshot({path:dir+`/1440-${state}.png`});
  if(state==='paused')await paintedIs('状態paused','play-icon');
  if(state==='loading'){check('buffering separate from paused',await page.locator('#spinner').isVisible()&&await page.locator('#playback-message').textContent()==='読み込み中…');await paintedIs('状態loading','spinner');}
  if(state==='translation')check('translated lines visible',await page.locator('.translation').count()===7);
  if(state==='lyrics-error'){await page.locator('#retry').click();check('retry loading visible',await page.locator('#lyric-message-text').textContent()==='歌詞を読み込んでいます…');await page.waitForTimeout(800);check('retry recovers mock lyrics',await page.locator('#lyric-viewport').isVisible());}
 }
 await load();await page.locator('#lyric-viewport').hover();await page.mouse.wheel(0,150);await page.locator('#resume-follow').waitFor({state:'visible'});check('manual scroll suspends follow',await page.locator('#resume-follow').isVisible());
 await page.locator('#resume-follow').click();check('resume hides return button',!(await page.locator('#resume-follow').isVisible()));
 await page.locator('.lyric-line').nth(3).click();check('line click seeks',Number(await page.locator('#seek').inputValue())===156);
 await page.locator('#next').focus();await page.screenshot({path:dir+'/1440-focus.png'});
 await page.emulateMedia({reducedMotion:'reduce'});await load('playing',false);
 await page.addStyleTag({content:'.stage,.view-switch { visibility: hidden !important; }'});const bg1=await page.locator('#smoke').screenshot();await page.waitForTimeout(500);const bg2=await page.locator('#smoke').screenshot();check('reduced motion freezes smoke',bg1.equals(bg2));
 await page.emulateMedia({reducedMotion:'no-preference'});await load('playing',false);await page.addStyleTag({content:'.stage,.view-switch { visibility: hidden !important; }'});const smoke1=await page.locator('#smoke').screenshot();await page.waitForTimeout(1800);const smoke2=await page.locator('#smoke').screenshot();check('smoke really animates',!smoke1.equals(smoke2));
 const metrics=await page.evaluate(()=>{const xs=window.frameCosts.slice(5).sort((a,b)=>a-b);return{frames:xs.length,meanMs:xs.reduce((a,b)=>a+b,0)/xs.length,p95Ms:xs[Math.floor(xs.length*.95)],maxMs:Math.max(...xs)}});
 const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');const getMetrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));const m1=await getMetrics();await page.waitForTimeout(1500);const m2=await getMetrics();
 check('no per-frame layout on steady playback',m2.LayoutCount-m1.LayoutCount<5);
 // 背景だけを撮って、白文字に対する最小コントラスト比を測る。
 // 明るいジャケットで歌詞が読めなくなる問題を数値で追えるようにするため。
 await page.emulateMedia({reducedMotion:'no-preference'});
 const contrast={};
 for(const state of ['playing','long','neutral']){
  await load(state);
  await page.addStyleTag({content:'.stage,.view-switch { visibility: hidden !important; }'});
  const shot=(await page.screenshot()).toString('base64');
  contrast[state]=await page.evaluate(async b64=>{
   const img=new Image();
   await new Promise(res=>{img.onload=res;img.src='data:image/png;base64,'+b64});
   const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
   const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
   const d=g.getImageData(0,0,c.width,c.height).data;
   const lin=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
   let whole=Infinity,lyrics=Infinity;
   const lyricsFrom=Math.round(c.width*0.56);
   for(let y=0;y<c.height;y+=2)for(let x=0;x<c.width;x+=2){
    const i=(y*c.width+x)*4;
    const L=0.2126*lin(d[i])+0.7152*lin(d[i+1])+0.0722*lin(d[i+2]);
    const ratio=1.05/(L+0.05);
    if(ratio<whole)whole=ratio;
    if(x>=lyricsFrom&&ratio<lyrics)lyrics=ratio;
   }
   return {whole:Math.round(whole*100)/100,lyrics:Math.round(lyrics*100)/100};
  },shot);
 }
 fs.writeFileSync(dir+'/contrast.json',JSON.stringify({note:'白文字(#fff)に対する背景の最小コントラスト比。1440x900、前景を隠して測定。WCAG AA の本文は 4.5:1。',contrast},null,2));
 check('コントラスト測定を書き出した',Object.keys(contrast).length===3);
 check('no external requests',requests.length===0);check('no browser JS errors',errors.length===0);
 const report={checks,errors,externalRequests:requests,contrast,performance:{...metrics,steadyLayoutCount:m2.LayoutCount-m1.LayoutCount,steadyLayoutDurationMs:(m2.LayoutDuration-m1.LayoutDuration)*1000},browser:browser.version()};
 fs.writeFileSync(dir+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
