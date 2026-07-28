const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('../database');
const { createApp } = require('../app');
const { createAuth, LOGIN_CSRF_MS } = require('../lib/auth');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'static-host-http-'));
  await Promise.all(['sites','uploads','database','public','showcase'].map((name) => fs.mkdir(path.join(root,name),{recursive:true})));
  for (const file of ['index.html','app.js','style.css','login.html','login.js','login.css']) {
    await fs.writeFile(path.join(root,'public',file), '<!doctype html>');
  }
  for (const file of ['index.html','detail.html','articles.html','article.html']) await fs.writeFile(path.join(root,'showcase',file), '<!doctype html>');
  const db = new Database({
    dbPath: path.join(root,'database','platform.db'),
    legacyJsonPath: path.join(root,'database','sites.json'),
    env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '123456' }
  });
  await db.init();
  const app = createApp({ db, rootDir: root });
  const server = await new Promise((resolve) => { const value = app.listen(0,'127.0.0.1',()=>resolve(value)); });
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  t.after(async()=>{ await new Promise((resolve)=>server.close(resolve)); db.close(); await fs.rm(root,{recursive:true,force:true}); });
  return { db, root, base };
}

function cookiesFrom(response) {
  const values = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')];
  const cookies = values.filter(Boolean).map((value)=>value.split(';')[0]);
  const value = (name) => decodeURIComponent(cookies.find((cookie)=>cookie.startsWith(`${name}=`))?.slice(name.length + 1) || '');
  return {
    header: cookies.join('; '),
    csrf: value('zcode_csrf'),
    loginCsrf: value('zcode_login_csrf')
  };
}

async function login(base, username='admin', password='123456', origin) {
  const challengeResponse = await fetch(`${base}/login`);
  const challenge = cookiesFrom(challengeResponse);
  const headers = {
    Cookie:challenge.header,
    'X-Login-CSRF-Token':challenge.loginCsrf,
    'Content-Type':'application/json'
  };
  if (origin !== undefined) headers.Origin = origin;
  const response = await fetch(`${base}/api/auth/login`, { method:'POST', headers, body:JSON.stringify({username,password}) });
  return { response, ...cookiesFrom(response) };
}

function secureHeaders(_base, session) { return { Cookie:session.header, 'X-CSRF-Token':session.csrf, 'Content-Type':'application/json' }; }
async function waitForEmptyDir(directory) {
  for (let attempt=0;attempt<50;attempt+=1) {
    if ((await fs.readdir(directory)).length===0) return;
    await new Promise((resolve)=>setTimeout(resolve,10));
  }
  assert.deepEqual(await fs.readdir(directory),[]);
}
function hostRequest(base, host, pathname='/', options={}) {
  const port = new URL(base).port;
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname:'127.0.0.1', port, path:pathname, method:options.method || 'GET',
      headers:{Host:host,...options.headers}
    }, (response) => {
      let body=''; response.setEncoding('utf8'); response.on('data',(chunk)=>body+=chunk); response.on('end',()=>resolve({status:response.statusCode,body,headers:response.headers}));
    });
    request.on('error',reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

test('未登录不能进入后台或管理 API', async(t)=>{
  const {base}=await fixture(t);
  const page=await fetch(`${base}/admin/`,{redirect:'manual'});
  assert.equal(page.status,302); assert.equal(page.headers.get('location'),'/login');
  assert.equal((await fetch(`${base}/api/sites`)).status,401);
});

test('默认管理员可以登录并通过 CSRF 创建编辑账号', async(t)=>{
  const {base}=await fixture(t); const session=await login(base);
  assert.equal(session.response.status,200); assert.ok(session.header.includes('zcode_session=')); assert.ok(session.csrf);
  const me=await fetch(`${base}/api/auth/me`,{headers:{Cookie:session.header}}); assert.equal(me.status,200);
  const missingCsrf=await fetch(`${base}/api/users`,{method:'POST',headers:{Cookie:session.header,Origin:base,'Content-Type':'application/json'},body:'{}'}); assert.equal(missingCsrf.status,403);
  const created=await fetch(`${base}/api/users`,{method:'POST',headers:secureHeaders(base,session),body:JSON.stringify({username:'editor1',password:'abcdef',role:'editor'})});
  assert.equal(created.status,201);
});

test('编辑者只能管理自己的站点，管理员可以管理全部站点',async(t)=>{
  const {base,db,root}=await fixture(t); const admin=await login(base);
  for(const name of ['editor_a','editor_b']) await fetch(`${base}/api/users`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({username:name,password:'abcdef',role:'editor'})});
  const a=db.getUserByUsername('editor_a'), b=db.getUserByUsername('editor_b');
  const siteId='12345678-1234-4234-8234-123456789012';
  await fs.mkdir(path.join(root,'sites',siteId),{recursive:true}); await fs.writeFile(path.join(root,'sites',siteId,'index.html'),'ok');
  await db.createSite({id:siteId,name:'Owned',path:path.join(root,'sites',siteId)},a.id);
  const sa=await login(base,'editor_a','abcdef'), sb=await login(base,'editor_b','abcdef');
  assert.equal((await (await fetch(`${base}/api/sites`,{headers:{Cookie:sa.header}})).json()).sites.length,1);
  assert.equal((await (await fetch(`${base}/api/sites`,{headers:{Cookie:sb.header}})).json()).sites.length,0);
  assert.equal((await fetch(`${base}/api/sites/${siteId}`,{method:'DELETE',headers:secureHeaders(base,sb)})).status,404);
  assert.equal((await fetch(`${base}/api/sites/${siteId}`,{method:'DELETE',headers:secureHeaders(base,admin)})).status,200);
});

test('最后一个有效管理员不能被降级',async(t)=>{
  const {base,db}=await fixture(t); const session=await login(base); const admin=db.getUserByUsername('admin');
  const response=await fetch(`${base}/api/users/${admin.id}`,{method:'PATCH',headers:secureHeaders(base,session),body:JSON.stringify({role:'editor'})});
  assert.equal(response.status,400);
});

test('任意合法 Host 可访问，畸形 Host 被拒绝',async(t)=>{
  const {base}=await fixture(t);
  assert.equal((await hostRequest(base,'localhost','/health')).status,200);
  assert.equal((await hostRequest(base,'unknown.custom.dev','/health')).status,200);
  for (const host of ['-bad.example','bad..example','example.com/path','example.com:bad']) {
    assert.equal((await hostRequest(base,host,'/health')).status,400,host);
  }
});

test('GET /login 每次签发短期双提交 Cookie，任意 Host 可完成登录',async(t)=>{
  const {base}=await fixture(t);
  const first=await hostRequest(base,'tenant.example.test','/login');
  const second=await hostRequest(base,'tenant.example.test','/api/auth/login-challenge');
  const firstSetCookie=first.headers['set-cookie'][0], secondSetCookie=second.headers['set-cookie'][0];
  assert.equal(first.status,200); assert.equal(second.status,200); assert.equal(JSON.parse(second.body).success,true); assert.match(firstSetCookie,/^zcode_login_csrf=/);
  assert.match(firstSetCookie,/Max-Age=300/); assert.match(firstSetCookie,/SameSite=Lax/); assert.doesNotMatch(firstSetCookie,/HttpOnly/);
  const token=decodeURIComponent(firstSetCookie.split(';')[0].split('=')[1]);
  assert.notEqual(token,decodeURIComponent(secondSetCookie.split(';')[0].split('=')[1]));

  const response=await hostRequest(base,'tenant.example.test','/api/auth/login',{
    method:'POST',
    headers:{Cookie:`zcode_login_csrf=${encodeURIComponent(token)}`,'X-Login-CSRF-Token':token,'Content-Type':'application/json',Origin:'https://unrelated.example'},
    body:JSON.stringify({username:'admin',password:'123456'})
  });
  assert.equal(response.status,200); assert.equal(response.headers['access-control-allow-origin'],undefined);
  assert.ok(response.headers['set-cookie'].some((cookie)=>/^zcode_login_csrf=;/.test(cookie) && /Max-Age=0/.test(cookie)));
  assert.ok(response.headers['set-cookie'].some((cookie)=>/^zcode_session=/.test(cookie)));
  assert.ok(response.headers['set-cookie'].some((cookie)=>/^zcode_csrf=/.test(cookie)));
});

test('登录拒绝缺失或错误的双提交 token，Origin 不影响有效登录',async(t)=>{
  const {base}=await fixture(t);
  const challengeResponse=await fetch(`${base}/login`); const challenge=cookiesFrom(challengeResponse);
  const payload=JSON.stringify({username:'admin',password:'123456'});
  const missing=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{Cookie:challenge.header,'Content-Type':'application/json'},body:payload});
  assert.equal(missing.status,403);
  const wrong=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{Cookie:challenge.header,'X-Login-CSRF-Token':'wrong','Content-Type':'application/json'},body:payload});
  assert.equal(wrong.status,403);
  assert.equal((await login(base,'admin','123456','https://evil.example')).response.status,200);
});

test('登录双提交 token 在服务端超过五分钟后失效',()=>{
  let timestamp=1_800_000_000_000;
  const auth=createAuth({}, {loginCsrfSecret:Buffer.alloc(32,7),now:()=>timestamp});
  const issued=auth.issueLoginCsrf();
  const request={headers:{cookie:`zcode_login_csrf=${encodeURIComponent(issued.token)}`},get(name){return name.toLowerCase()==='x-login-csrf-token'?issued.token:undefined;}};
  let status=0,body;
  const response={status(value){status=value;return this;},json(value){body=value;return this;}};
  let nextCalled=false;
  auth.loginCsrf(request,response,()=>{nextCalled=true;});
  assert.equal(nextCalled,true);
  timestamp+=LOGIN_CSRF_MS+1; nextCalled=false; status=0; body=undefined;
  auth.loginCsrf(request,response,()=>{nextCalled=true;});
  assert.equal(nextCalled,false); assert.equal(status,403); assert.match(body.error,/登录 CSRF/);
});

test('失败冷却只限制错误凭据，冷却期间正确密码仍可登录',async(t)=>{
  const {base}=await fixture(t);
  for(let attempt=0;attempt<5;attempt+=1) assert.equal((await login(base,'admin','wrong-password')).response.status,401);
  assert.equal((await login(base,'admin','wrong-password')).response.status,429);
  assert.equal((await login(base,'admin','123456')).response.status,200);
});

test('管理员和编辑者可凭当前密码自助修改用户名与密码',async(t)=>{
  const {base}=await fixture(t); const admin=await login(base);
  await fetch(`${base}/api/users`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({username:'taken_name',password:'abcdef',role:'editor'})});
  await fetch(`${base}/api/users`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({username:'self_editor',password:'abcdef',role:'editor'})});

  const changed=await fetch(`${base}/api/auth/profile`,{method:'PATCH',headers:{...secureHeaders(base,admin),Origin:'https://evil.example'},body:JSON.stringify({username:'new_admin',currentPassword:'123456'})});
  assert.equal(changed.status,200);
  assert.equal((await fetch(`${base}/api/auth/me`,{headers:{Cookie:admin.header}})).status,401);
  const relogin=await login(base,'new_admin','123456'); assert.equal(relogin.response.status,200);
  const conflict=await fetch(`${base}/api/auth/profile`,{method:'PATCH',headers:secureHeaders(base,relogin),body:JSON.stringify({username:'TAKEN_NAME',currentPassword:'123456'})});
  assert.equal(conflict.status,409);
  const adminPassword=await fetch(`${base}/api/auth/change-password`,{method:'POST',headers:secureHeaders(base,relogin),body:JSON.stringify({currentPassword:'123456',newPassword:'admin-new-password'})});
  assert.equal(adminPassword.status,200); assert.equal((await login(base,'new_admin','admin-new-password')).response.status,200);

  const editor=await login(base,'self_editor','abcdef');
  const editorName=await fetch(`${base}/api/auth/profile`,{method:'PATCH',headers:secureHeaders(base,editor),body:JSON.stringify({username:'renamed_editor',currentPassword:'abcdef'})});
  assert.equal(editorName.status,200);
  const renamed=await login(base,'renamed_editor','abcdef');
  const editorPassword=await fetch(`${base}/api/auth/change-password`,{method:'POST',headers:secureHeaders(base,renamed),body:JSON.stringify({currentPassword:'abcdef',newPassword:'editor-new-password'})});
  assert.equal(editorPassword.status,200); assert.equal((await login(base,'renamed_editor','editor-new-password')).response.status,200);
});

test('管理员不能通过用户管理接口修改或撤销当前账号',async(t)=>{
  const {base,db}=await fixture(t); const admin=await login(base); const id=db.getUserByUsername('admin').id;
  const cases=[
    ['PATCH',`/api/users/${id}`,{username:'bypass_name'}],
    ['POST',`/api/users/${id}/reset-password`,{password:'bypass-password'}],
    ['POST',`/api/users/${id}/revoke-sessions`,{}]
  ];
  for(const [method,pathname,body] of cases){
    const response=await fetch(`${base}${pathname}`,{method,headers:secureHeaders(base,admin),body:JSON.stringify(body)});
    assert.equal(response.status,400,pathname);
  }
  assert.equal((await login(base,'admin','123456')).response.status,200);
});

test('管理员可以按账号查看该账号的页面',async(t)=>{
  const {base,db}=await fixture(t); const admin=await login(base);
  await fetch(`${base}/api/users`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({username:'owner_one',password:'abcdef',role:'editor'})});
  const owner=db.getUserByUsername('owner_one');
  await db.createSite({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Owner page',path:'/tmp/page'},owner.id);
  const response=await fetch(`${base}/api/users/${owner.id}/sites`,{headers:{Cookie:admin.header}}); const body=await response.json();
  assert.equal(response.status,200); assert.equal(body.sites.length,1); assert.equal(body.sites[0].ownerId,owner.id);
  const editor=await login(base,'owner_one','abcdef'); assert.equal((await fetch(`${base}/api/users/${owner.id}/sites`,{headers:{Cookie:editor.header}})).status,403);
});

test('移除后的域名 API 返回 404',async(t)=>{
  const {base}=await fixture(t); const admin=await login(base);
  const response=await fetch(`${base}/api/sites/12345678-1234-4234-8234-123456789012/domain`,{method:'PUT',headers:secureHeaders(base,admin),body:'{}'});
  assert.equal(response.status,404);
});

test('管理员可设置 ZIP 上传限制，编辑者只可读取当前限制',async(t)=>{
  const {base}=await fixture(t); const admin=await login(base);
  assert.equal((await fetch(`${base}/api/upload-config`)).status,401);
  const publicSettings=await (await fetch(`${base}/api/settings`)).json();
  assert.equal(publicSettings.settings.uploads,undefined);
  const adminSettings=await fetch(`${base}/api/admin/settings`,{headers:{Cookie:admin.header}}); const adminBody=await adminSettings.json();
  assert.equal(adminSettings.status,200); assert.equal(adminSettings.headers.get('cache-control'),'no-store'); assert.equal(adminBody.settings.uploads.maxFileSize,50*1024*1024);
  const noCsrf=await fetch(`${base}/api/admin/settings`,{method:'PATCH',headers:{Cookie:admin.header,'Content-Type':'application/json'},body:JSON.stringify({uploads:{maxFileSize:8*1024*1024}})});
  assert.equal(noCsrf.status,403);
  const invalid=await fetch(`${base}/api/admin/settings`,{method:'PATCH',headers:secureHeaders(base,admin),body:JSON.stringify({uploads:{maxFileSize:0}})});
  assert.equal(invalid.status,400);
  const updated=await fetch(`${base}/api/admin/settings`,{method:'PATCH',headers:secureHeaders(base,admin),body:JSON.stringify({uploads:{maxFileSize:8*1024*1024}})});
  assert.equal(updated.status,200); assert.equal((await updated.json()).settings.uploads.maxFileSize,8*1024*1024);

  await fetch(`${base}/api/users`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({username:'upload_editor',password:'abcdef',role:'editor'})});
  const editor=await login(base,'upload_editor','abcdef');
  const config=await fetch(`${base}/api/upload-config`,{headers:{Cookie:editor.header}}); const configBody=await config.json();
  assert.equal(config.status,200); assert.equal(config.headers.get('cache-control'),'no-store'); assert.equal(configBody.uploads.maxFileSize,8*1024*1024);
  assert.equal(configBody.uploads.minFileSize,1024*1024); assert.equal(configBody.uploads.maxAllowedFileSize,200*1024*1024);
  assert.equal((await fetch(`${base}/api/admin/settings`,{headers:{Cookie:editor.header}})).status,403);
  assert.equal((await fetch(`${base}/api/admin/settings`,{method:'PATCH',headers:secureHeaders(base,editor),body:JSON.stringify({uploads:{maxFileSize:9*1024*1024}})})).status,403);
});

test('页面管理 CRUD 保持管理员权限与 CSRF 校验',async(t)=>{
  const {base}=await fixture(t); const admin=await login(base);
  const unauthenticated=await fetch(`${base}/api/admin/pages`); assert.equal(unauthenticated.status,401);
  const noCsrf=await fetch(`${base}/api/admin/pages`,{method:'POST',headers:{Cookie:admin.header,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({slug:'guide',title:'Guide'})});
  assert.equal(noCsrf.status,403);

  const editorCreated=await fetch(`${base}/api/users`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({username:'page_editor',password:'abcdef',role:'editor'})});
  assert.equal(editorCreated.status,201);
  const editor=await login(base,'page_editor','abcdef');
  assert.equal((await fetch(`${base}/api/admin/pages`,{headers:{Cookie:editor.header}})).status,403);
  assert.equal((await fetch(`${base}/api/admin/pages`,{method:'POST',headers:secureHeaders(base,editor),body:JSON.stringify({slug:'forbidden',title:'Forbidden'})})).status,403);

  const created=await fetch(`${base}/api/admin/pages`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({slug:'guide',title:'Guide',content:'# Hello',published:true,sort_order:5})});
  const createdBody=await created.json();
  assert.equal(created.status,201); assert.equal(createdBody.page.slug,'guide'); assert.equal(createdBody.page.published,true); assert.equal(typeof createdBody.page.then,'undefined');

  const patched=await fetch(`${base}/api/admin/pages/${createdBody.page.id}`,{method:'PATCH',headers:secureHeaders(base,admin),body:JSON.stringify({title:'Updated guide',sort_order:1})});
  assert.equal(patched.status,200); assert.equal((await patched.json()).page.title,'Updated guide');
  const listed=await fetch(`${base}/api/admin/pages`,{headers:{Cookie:admin.header}}); assert.equal(listed.headers.get('cache-control'),'no-store'); assert.equal((await listed.json()).pages.length,1);
  assert.equal((await fetch(`${base}/api/admin/pages/${createdBody.page.id}`,{method:'DELETE',headers:secureHeaders(base,admin)})).status,200);
  assert.equal((await fetch(`${base}/api/admin/pages/${createdBody.page.id}`,{method:'DELETE',headers:secureHeaders(base,admin)})).status,404);
});

test('gallery 仅返回带作者的站点，详情也包含作者',async(t)=>{
  const {base,db}=await fixture(t); const admin=db.getUserByUsername('admin');
  const id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  await db.createSite({id,name:'Published work',path:'/tmp/work',published:true},admin.id);
  await db.createPage({slug:'gallery-article',title:'Gallery article',content:'body',published:true});
  const response=await fetch(`${base}/api/gallery`); const body=await response.json();
  assert.equal(response.status,200); assert.equal(Object.hasOwn(body,'articles'),false);
  assert.equal(body.sites.length,1); assert.equal(body.sites[0].ownerUsername,'admin');
  const detail=await (await fetch(`${base}/api/gallery/${id}`)).json();
  assert.equal(detail.site.ownerUsername,'admin');
});

test('标准页面 API 排序并隐藏草稿，articles API 保持兼容',async(t)=>{
  const {base,db}=await fixture(t);
  await db.createPage({slug:'second',title:'Second',category:'docs',content:'second',published:true,sort_order:20});
  await db.createPage({slug:'first',title:'First',category:'docs',content:'# First',published:true,sort_order:1});
  await db.createPage({slug:'draft',title:'Draft',category:'docs',content:'secret',published:false,sort_order:0});

  const response=await fetch(`${base}/api/pages?category=docs`); const body=await response.json();
  assert.equal(response.status,200); assert.deepEqual(body.pages.map((page)=>page.slug),['first','second']); assert.equal(body.pages[0].url,'/pages/first');
  const detail=await (await fetch(`${base}/api/pages/first`)).json(); assert.equal(detail.page.contentHtml,'<h1 id="first">First</h1>');
  assert.equal(detail.page.next.slug,'second'); assert.equal(detail.page.prev,null);
  assert.equal((await fetch(`${base}/api/pages/draft`)).status,404);
  assert.equal((await fetch(`${base}/pages/draft`)).status,404);
  assert.equal((await fetch(`${base}/pages/first`)).status,200);
  assert.equal((await fetch(`${base}/pages`)).status,200);

  const legacyList=await (await fetch(`${base}/api/articles`)).json(); assert.deepEqual(legacyList.articles.map((page)=>page.slug),['first','second']); assert.equal(legacyList.articles[0].url,'/pages/first');
  const legacyDetail=await (await fetch(`${base}/api/articles/first`)).json(); assert.equal(legacyDetail.article.slug,'first');
  assert.equal((await fetch(`${base}/articles/first`)).status,200);
});

test('Markdown 预览不落库、拒绝未授权请求并转义 XSS',async(t)=>{
  const {base}=await fixture(t); const admin=await login(base);
  const markdown='# Preview\n\n<script>alert(1)</script> [bad](javascript:alert(2))';
  assert.equal((await fetch(`${base}/api/admin/pages/preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:markdown})})).status,401);
  assert.equal((await fetch(`${base}/api/admin/pages/preview`,{method:'POST',headers:{Cookie:admin.header,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({content:markdown})})).status,403);

  const response=await fetch(`${base}/api/admin/pages/preview`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({content:markdown})}); const body=await response.json();
  assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store'); assert.equal(body.toc[0].text,'Preview');
  assert.ok(body.contentHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.equal(body.contentHtml.includes('<script>'),false); assert.equal(body.contentHtml.includes('href="javascript:'),false);
  const pages=await (await fetch(`${base}/api/admin/pages`,{headers:{Cookie:admin.header}})).json(); assert.equal(pages.pages.length,0);
});

test('页面 API 校验非法字段、重复 slug 并安全渲染已发布内容',async(t)=>{
  const {base}=await fixture(t); const admin=await login(base);
  const invalid=await fetch(`${base}/api/admin/pages`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({slug:'bad-',title:'Bad'})}); assert.equal(invalid.status,400);
  const wrongTypes=await fetch(`${base}/api/admin/pages`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({slug:'typed',title:'Typed',published:'yes',sort_order:'1'})}); assert.equal(wrongTypes.status,400);
  const payload={slug:'safe',title:'Safe',content:'<img src=x onerror=alert(1)>\n\n[link](javascript:alert(2))',published:true,sort_order:0};
  assert.equal((await fetch(`${base}/api/admin/pages`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify(payload)})).status,201);
  assert.equal((await fetch(`${base}/api/admin/pages`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify(payload)})).status,409);
  const detail=await (await fetch(`${base}/api/pages/safe`)).json();
  assert.ok(detail.page.contentHtml.includes('&lt;img src=x onerror=alert(1)&gt;')); assert.equal(detail.page.contentHtml.includes('<img'),false); assert.equal(detail.page.contentHtml.includes('href="javascript:'),false);
});

test('公开源码下载返回 ZIP 与下载头，隐藏源码返回 403',async(t)=>{
  const {base,db,root}=await fixture(t); const admin=db.getUserByUsername('admin');
  const publicId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', privateId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  for(const id of [publicId,privateId]){await fs.mkdir(path.join(root,'sites',id),{recursive:true});await fs.writeFile(path.join(root,'sites',id,'index.html'),`site ${id}`);}
  await db.createSite({id:publicId,name:'示例 项目',path:path.join(root,'sites',publicId),published:true,source_visible:true},admin.id);
  await db.createSite({id:privateId,name:'Private',path:path.join(root,'sites',privateId),published:true,source_visible:false},admin.id);

  const download=await fetch(`${base}/api/gallery/${publicId}/download`); const bytes=Buffer.from(await download.arrayBuffer());
  assert.equal(download.status,200); assert.equal(download.headers.get('content-type'),'application/zip'); assert.equal(Number(download.headers.get('content-length')),bytes.length);
  assert.equal(download.headers.get('cache-control'),'no-store'); assert.match(download.headers.get('content-disposition'),/^attachment; filename="project\.zip"; filename\*=UTF-8''/); assert.equal(bytes.readUInt32LE(0),0x04034b50);
  assert.equal((await fetch(`${base}/api/gallery/${privateId}/download`)).status,403);
});

test('托管站点的所有文件统一使用 sandbox CSP，避免活动文档获得平台同源权限',async(t)=>{
  const {base,db,root}=await fixture(t); const admin=db.getUserByUsername('admin'); const id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await fs.mkdir(path.join(root,'sites',id),{recursive:true});
  await fs.writeFile(path.join(root,'sites',id,'index.html'),'<script>document.body.textContent="ok"</script>');
  await fs.writeFile(path.join(root,'sites',id,'payload.xhtml'),'<script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script>');
  await fs.writeFile(path.join(root,'sites',id,'data.txt'),'plain');
  await db.createSite({id,name:'Sandboxed',path:path.join(root,'sites',id),published:true},admin.id);
  for(const file of ['','payload.xhtml','data.txt']){
    const response=await fetch(`${base}/sites/${id}/${file}`);
    assert.equal(response.status,200); assert.match(response.headers.get('content-security-policy'),/^sandbox /); assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  }
});

test('站点上传拒绝多个 file 字段并清理临时文件',async(t)=>{
  const {base,root}=await fixture(t); const admin=await login(base);
  const duplicate=new FormData(); duplicate.append('file',new Blob(['one']), 'one.zip'); duplicate.append('file',new Blob(['two']), 'two.zip');
  const duplicateResponse=await fetch(`${base}/api/sites`,{method:'POST',headers:{Origin:base,Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:duplicate});
  assert.equal(duplicateResponse.status,400); await waitForEmptyDir(path.join(root,'uploads'));
  const unknown=new FormData(); unknown.append('file',new Blob(['one']),'one.zip'); unknown.append('asset',new Blob(['two']),'asset.zip');
  const unknownResponse=await fetch(`${base}/api/sites`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:unknown});
  assert.equal(unknownResponse.status,400); await waitForEmptyDir(path.join(root,'uploads'));
  const unknownField=new FormData(); unknownField.append('file',new Blob(['one']),'one.zip'); unknownField.append('published','true');
  assert.equal((await fetch(`${base}/api/sites`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:unknownField})).status,400);
  const repeatedName=new FormData(); repeatedName.append('file',new Blob(['one']),'one.zip'); repeatedName.append('name','First'); repeatedName.append('name','Second');
  assert.equal((await fetch(`${base}/api/sites`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:repeatedName})).status,400);
  await waitForEmptyDir(path.join(root,'uploads'));
});

test('畸形 multipart 返回 400 并清理解析阶段的 ZIP 临时文件',async(t)=>{
  const {base,root}=await fixture(t); const admin=await login(base); const boundary='zcode-truncated-boundary';
  const payload=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.zip"\r\nContent-Type: application/zip\r\n\r\nPK-test-data\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\ntruncated`);
  const response=await hostRequest(base,'localhost','/api/sites',{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(payload.length)},body:payload});
  assert.equal(response.status,400); assert.match(response.body,/上传数据格式无效/); await waitForEmptyDir(path.join(root,'uploads'));

  const activeBoundary='zcode-active-file-truncated';
  const activePayload=Buffer.from(`--${activeBoundary}\r\nContent-Disposition: form-data; name="file"; filename="active.zip"\r\nContent-Type: application/zip\r\n\r\nPK-file-content-without-closing-boundary`);
  const activeResponse=await hostRequest(base,'localhost','/api/sites',{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf,'Content-Type':`multipart/form-data; boundary=${activeBoundary}`,'Content-Length':String(activePayload.length)},body:activePayload});
  assert.equal(activeResponse.status,400); assert.match(activeResponse.body,/上传数据格式无效|ZIP 文件读取失败/); await waitForEmptyDir(path.join(root,'uploads'));
});

test('ZIP 上传限制在后台修改后无需重启即返回 413 且不留残余',async(t)=>{
  const {base,db,root}=await fixture(t); const admin=await login(base);
  const before=await fetch(`${base}/api/upload-config`,{headers:{Cookie:admin.header}}); assert.equal((await before.json()).uploads.maxFileSize,50*1024*1024);
  const changed=await fetch(`${base}/api/admin/settings`,{method:'PATCH',headers:secureHeaders(base,admin),body:JSON.stringify({uploads:{maxFileSize:1024*1024}})});
  assert.equal(changed.status,200); assert.equal(db.getSettings().uploads.maxFileSize,1024*1024);
  const exact=new FormData(); exact.append('name','Exact boundary'); exact.append('file',new Blob([new Uint8Array(1024*1024)]),'exact.zip');
  const exactResponse=await fetch(`${base}/api/sites`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:exact});
  assert.equal(exactResponse.status,400); assert.doesNotMatch((await exactResponse.json()).error,/不能超过/); await waitForEmptyDir(path.join(root,'uploads'));
  const form=new FormData(); form.append('name','Too large'); form.append('file',new Blob([new Uint8Array(1024*1024+1)]),'large.zip');
  const response=await fetch(`${base}/api/sites`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:form});
  assert.equal(response.status,413); assert.match(await response.text(),/1 MiB/);
  assert.equal((await db.getAllSites()).length,0); assert.deepEqual(await fs.readdir(path.join(root,'sites')),[]); await waitForEmptyDir(path.join(root,'uploads'));
});

test('管理员可粘贴三类代码创建草稿站点并保留 UTF-8 内容',async(t)=>{
  const {base,db,root}=await fixture(t); const admin=await login(base);
  const form=new FormData(); form.append('name','粘贴站点'); form.append('description','三个固定文件');
  form.append('html',new Blob(['<main><h1>你好</h1></main>'],{type:'text/html'}),'index.html');
  form.append('css',new Blob(['h1 { color: red; }'],{type:'text/css'}),'style.css');
  form.append('javascript',new Blob(['document.body.dataset.ready = "是";'],{type:'text/javascript'}),'script.js');
  const response=await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:form});
  const body=await response.json(); assert.equal(response.status,201); assert.equal(body.site.name,'粘贴站点');
  assert.equal(body.site.published,false); assert.equal(body.site.sourceVisible,true); assert.equal(body.site.ownerUsername,'admin');
  const site=await db.getSiteById(body.site.id); assert.equal(site.owner_user_id,db.getUserByUsername('admin').id);
  const directory=path.join(root,'sites',body.site.id);
  const [html,css,javascript]=await Promise.all(['index.html','style.css','script.js'].map((file)=>fs.readFile(path.join(directory,file),'utf8')));
  assert.match(html,/<!doctype html>/); assert.match(html,/<h1>你好<\/h1>/); assert.match(html,/href="style\.css"/); assert.match(html,/src="script\.js"/);
  assert.equal(css,'h1 { color: red; }'); assert.equal(javascript,'document.body.dataset.ready = "是";');
});

test('编辑者可创建自己的完整 HTML 站点且资源引用不重复',async(t)=>{
  const {base,db,root}=await fixture(t); const admin=await login(base);
  await fetch(`${base}/api/users`,{method:'POST',headers:secureHeaders(base,admin),body:JSON.stringify({username:'code_editor',password:'abcdef',role:'editor'})});
  const editor=await login(base,'code_editor','abcdef');
  const form=new FormData(); form.append('name','Editor code');
  form.append('html',new Blob(['<!doctype html><html><head><link rel="stylesheet" href="./style.css?v=1"></head><body>Editor<script src="assets/script.js#run"></script></body></html>']),'index.html');
  form.append('css',new Blob(['body{}']),'style.css'); form.append('javascript',new Blob(['run()']),'script.js');
  const response=await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:editor.header,'X-CSRF-Token':editor.csrf},body:form});
  const body=await response.json(); assert.equal(response.status,201); assert.equal(body.site.ownerUsername,'code_editor');
  const html=await fs.readFile(path.join(root,'sites',body.site.id,'index.html'),'utf8');
  assert.equal((html.match(/style\.css/g)||[]).length,1); assert.equal((html.match(/script\.js/g)||[]).length,2); assert.match(html,/src="script\.js"/);
  assert.equal((await db.getAllSites(db.getUserByUsername('code_editor').id)).length,1);
});

test('代码上传要求认证与 CSRF，并拒绝无名称、无 HTML 和异常文件字段',async(t)=>{
  const {base,db,root}=await fixture(t); const admin=await login(base);
  function codeForm(name='Site'){const form=new FormData();if(name!==null)form.append('name',name);form.append('html',new Blob(['<main>ok</main>']),'index.html');return form;}
  assert.equal((await fetch(`${base}/api/sites/code`,{method:'POST',body:codeForm()})).status,401);
  assert.equal((await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header},body:codeForm()})).status,403);
  assert.equal((await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:codeForm('')})).status,400);
  const missing=new FormData(); missing.append('name','Missing HTML');
  assert.equal((await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:missing})).status,400);
  const duplicate=codeForm('Duplicate'); duplicate.append('html',new Blob(['again']),'second.html');
  assert.equal((await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:duplicate})).status,400);
  const extra=codeForm('Extra'); extra.append('asset',new Blob(['bad']),'asset.txt');
  assert.equal((await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:extra})).status,400);
  const extraBody=codeForm('Extra body'); extraBody.append('published','true');
  assert.equal((await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:extraBody})).status,400);
  const repeatedName=codeForm('First'); repeatedName.append('name','Second');
  assert.equal((await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:repeatedName})).status,400);
  const tooManyParts=codeForm('Parts'); tooManyParts.append('description','one'); tooManyParts.append('css',new Blob(['body{}']),'style.css'); tooManyParts.append('javascript',new Blob(['ready()']),'script.js'); tooManyParts.append('extra',new Blob(['bad']),'extra.txt');
  assert.equal((await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:tooManyParts})).status,413);
  assert.equal((await db.getAllSites()).length,0); assert.deepEqual(await fs.readdir(path.join(root,'sites')),[]);
});

test('代码上传在数据库创建失败后回滚目录和可能插入的记录',async(t)=>{
  const {base,db,root}=await fixture(t); const admin=await login(base); const createSite=db.createSite.bind(db);
  db.createSite=async(...args)=>{await createSite(...args);throw new Error('injected failure');};
  const form=new FormData(); form.append('name','Rollback'); form.append('html',new Blob(['<main>rollback</main>']),'index.html');
  const response=await fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:form});
  assert.equal(response.status,500); assert.equal((await db.getAllSites()).length,0); assert.deepEqual(await fs.readdir(path.join(root,'sites')),[]);
});

test('代码上传拒绝 NUL、无效 UTF-8 和单文件超限且不留残余',async(t)=>{
  const {base,db,root}=await fixture(t); const admin=await login(base);
  async function submit(bytes,name){const form=new FormData();form.append('name',name);form.append('html',new Blob([bytes]),'index.html');return fetch(`${base}/api/sites/code`,{method:'POST',headers:{Cookie:admin.header,'X-CSRF-Token':admin.csrf},body:form});}
  const nul=await submit(Uint8Array.from([65,0,66]),'NUL'); assert.equal(nul.status,400); assert.match((await nul.json()).error,/NUL/);
  const invalid=await submit(Uint8Array.from([0xc3,0x28]),'UTF8'); assert.equal(invalid.status,400); assert.match((await invalid.json()).error,/UTF-8/);
  const large=await submit(new Uint8Array(512*1024+1).fill(65),'Large'); assert.equal(large.status,413);
  assert.equal((await db.getAllSites()).length,0); assert.deepEqual(await fs.readdir(path.join(root,'sites')),[]);
});
