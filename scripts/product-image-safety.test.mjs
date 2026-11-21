import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createTestGateway, createMemoryStateStore, createFileStateStore, validateImageMultipart, headPublicObject } from './local-product-image-test-gateway.mjs';
import { inspectCleanup, runCleanup } from './cleanup-product-image-test.mjs';
import { inspectQuoteSnapshotImageReference, inspectStorageUrlReferenceValues } from './product-image-reference-safety.mjs';

const ID = '4d9319f3-47a6-4b65-9abd-113b4acd1f71';
const OTHER_ID = 'd40cf62d-f056-4f7c-9d70-eef1a780af31';
const SKU = 'IMGTEST-20261121-AB12CD34';
const REAL_SKU = 'TCBNLI500857';
const NAME = 'TEMPORARY IMAGE WORKFLOW TEST - DO NOT PUBLISH';
const ORIGIN = 'http://127.0.0.1:4200';
const PROJECT = 'https://ipegazjnkejasorskdur.supabase.co';
const OBJ1 = `products/${ID}/4fb05c3e-e518-48f0-9b1a-076ef09027bc.png`;
const OBJ2 = `products/${ID}/93a1d607-5b76-4ef2-8d5d-16e5b7cda021.png`;
const URL1 = `${PROJECT}/storage/v1/object/public/product-images/${OBJ1}`;
const URL2 = `${PROJECT}/storage/v1/object/public/product-images/${OBJ2}`;
const QUIET = { info(){}, warn(){}, error(){} };
async function removeTestTemp(path) {
  if (process.platform === 'win32') spawnSync('icacls.exe', [path, '/reset', '/T', '/C', '/Q'], { windowsHide: true, stdio: 'ignore' });
  await rm(path, { recursive: true, force: true });
}

function product(overrides = {}) { return { id: ID, sku: SKU, name: NAME, description: '', brand: 'TOTAL', category: 'Power Tools', price: 0, stock: 0, stock_quantity: 0, image: '', label: '', active: false, ...overrides }; }
function response(status, value) { return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(value)) }; }
function gatewayStub({ ambiguousCreate = false, ambiguousImage = false, ambiguousDelete = false, readDelay = null } = {}) {
  const calls = []; const storage = new Set(); let current = null; let createCalls = 0; let imageWrites = 0;
  const requestFn = async req => {
    calls.push(req);
    if (req.port === 43000) {
      if (req.path === '/api/admin/login') return response(401, {error:'invalid_credentials'});
      if (readDelay && req.path === '/api/admin/products') await readDelay;
      if (req.path === '/api/admin/products') return response(200, { products: current ? [current] : [] });
      if (req.path === '/api/admin/categories') return response(200, { categories: [{ name:'Power Tools', active:true }] });
      if (req.path === '/api/admin/brands') return response(200, { brands: [{ name:'TOTAL', active:true }] });
      return response(404, {});
    }
    assert.equal(req.port, 43001);
    if (req.method === 'POST' && req.path === '/api/admin/products') {
      createCalls++; current = product();
      return ambiguousCreate ? Promise.reject(new Error('lost create response')) : response(201, { product: current });
    }
    if (req.method === 'POST' && req.path.endsWith('/image')) {
      const image = imageWrites++ === 0 ? URL1 : URL2;
      if (current.image) storage.delete(current.image);
      current = { ...current, image }; storage.add(image);
      return ambiguousImage ? response(200, { image: URL2 }) : response(200, { image });
    }
    if (req.method === 'DELETE' && req.path.endsWith('/image')) {
      const old = current.image; current = { ...current, image: '' }; if (old) storage.delete(old);
      return ambiguousDelete ? response(200, { image: old || URL1 }) : response(200, { image: '' });
    }
    if (req.method === 'PUT') return response(200, { product: current });
    return response(404, {});
  };
  return { calls, requestFn, state: () => ({ current, createCalls, storage }) };
}

async function openGateway(stub = gatewayStub(), options = {}) {
  const gateway = createTestGateway({ requestFn: stub.requestFn, proxyFn: (req,res,port) => { stub.calls.push({port,path:req.url,method:req.method}); res.writeHead(200); res.end('{}'); }, headObjectFn: url => stub.state().storage.has(url) ? 200 : imageHeadFrom(options, url), stateStore: options.store || createMemoryStateStore({status:'ready'}), port:0, guardPort:43000, backendPort:43001, lifetimeMs:60_000, logger:QUIET });
  await gateway.start(); await new Promise((resolve,reject) => { gateway.server.once('error',reject); gateway.server.listen(0,'127.0.0.1',resolve); });
  const {port} = gateway.server.address();
  return { gateway, base:`http://127.0.0.1:${port}`, async close(){ await gateway.close(); } };
}
function imageHeadFrom(options, url) { return options.imageHead ? options.imageHead(url) : 404; }
function authHeaders(extra = {}) { return { authorization:'Bearer mocked-admin-session', origin:ORIGIN, ...extra }; }
async function postProduct(app, overrides = {}) { return fetch(`${app.base}/api/admin/products`, { method:'POST', headers:authHeaders({'content-type':'application/json'}), body:JSON.stringify({sku:SKU,name:NAME,description:'',brand:'TOTAL',category:'Power Tools',price:0,stock:0,image:'',label:'',inventoryReason:'',active:false,...overrides}) }); }
async function jsonRequest(app, method, path, body) { return fetch(`${app.base}${path}`, { method, headers:authHeaders({'content-type':'application/json'}), ...(body === undefined ? {} : {body:JSON.stringify(body)}) }); }
const fkRows = [
  {referencing_table:'inventory_movements',constraint_name:'inventory_movements_product_id_fkey'},
  {referencing_table:'order_items',constraint_name:'order_items_product_id_fkey'}
];
const refColumns = [
  {table_name:'inventory_movements',column_name:'product_id'}, {table_name:'order_items',column_name:'product_id'},
  {table_name:'products',column_name:'image'}, {table_name:'quote_requests',column_name:'products'}
];
function cleanupClient(overrides = {}) {
  const s = { product:product(), objects:[OBJ1], orders:[], movements:[], quotes:[], imageRefs:[], writes:[], pages:null, objectDeleteResult:'ok', productDeleteResult:'ok', beforeObjectDelete:null };
  Object.assign(s, overrides);
  const client = {
    async listProductForeignKeys(){ return s.fks !== undefined ? s.fks : fkRows; }, async listProductishColumns(){ return s.columns !== undefined ? s.columns : refColumns; },
    async getProduct(){ return s.product ? [s.product] : []; }, async findRows(table){ return table==='order_items' ? s.orders : s.movements; },
    async listQuoteSnapshots(){ return s.quotes; },
    async inspectProductImageReferences(url){ return s.imageRefs.includes(url) ? {inspectable:true,ambiguous:false,referenced:true} : {inspectable:true,ambiguous:false,referenced:false}; },
    async listProductObjects(prefix){ if (s.pages) return s.pages(prefix); return s.objects; },
    async deleteProductObject(path){ s.writes.push(['object',path]); if(s.objectDeleteResult==='throw') throw Error('mock delete failure'); if(s.objectDeleteResult==='ambiguous') return null; s.objects=s.objects.filter(x=>x!==path); },
    async deleteProductExact(id,sku){ s.writes.push(['product',id,sku]); if(s.productDeleteResult==='throw') throw Error('mock delete failure'); if(s.productDeleteResult==='ambiguous') return null; if(s.product?.id===id&&s.product?.sku===sku){s.product=null;return [{id,sku}]} return []; }
  };
  return {client,state:s};
}
async function cleanRun(client, confirmation=`${ID}:${SKU}`) { return runCleanup({client,projectUrl:PROJECT,productId:ID,sku:SKU,confirmation}); }

test('multipart validator accepts one bounded image and rejects extra fields', async () => {
  const valid='--x\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nabc\r\n--x--\r\n';
  await validateImageMultipart(Buffer.from(valid),'multipart/form-data; boundary=x');
  await assert.rejects(validateImageMultipart(Buffer.from('--x--\r\n'),'multipart/form-data; boundary=x'));
});

test('Supabase missing-object HEAD 400 is confirmed only by its exact bounded NoSuchKey body', async () => {
  const url=URL1; const calls=[];
  const fetchFn=async (_url,init)=>{
    calls.push(init);
    if(init.method==='HEAD') return new Response(null,{status:400,headers:{'content-type':'application/json; charset=utf-8','content-length':'88'}});
    return new Response(JSON.stringify({statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'}),{status:400,headers:{'content-type':'application/json; charset=utf-8'}});
  };
  assert.equal(await headPublicObject(url,fetchFn),404);
  assert.deepEqual(calls.map(x=>x.method),['HEAD','GET']);
  assert.equal(calls[1].headers.range,'bytes=0-0');
});

test('object probe treats auth, permission, server, malformed and oversized errors as unknown', async t => {
  const cases=[
    ['unauthorized',()=>new Response(JSON.stringify({statusCode:'401',error:'unauthorized',message:'Unauthorized',code:'InvalidJWT'}),{status:400,headers:{'content-type':'application/json'}})],
    ['permission denied',()=>new Response(JSON.stringify({statusCode:'403',error:'forbidden',message:'Forbidden',code:'AccessDenied'}),{status:403,headers:{'content-type':'application/json'}})],
    ['server error',()=>new Response('upstream failure',{status:503})],
    ['wrong missing shape',()=>new Response(JSON.stringify({statusCode:'404',error:'not_found',message:'Object not found',code:'Other'}),{status:400,headers:{'content-type':'application/json'}})],
    ['oversized body',()=>new Response('x'.repeat(4097),{status:400,headers:{'content-type':'application/json'}})]
  ];
  for(const [name,makeError] of cases) await t.test(name,async()=>{
    const fetchFn=async (_url,init)=>init.method==='HEAD'?new Response(null,{status:400}):makeError();
    assert.equal(await headPublicObject(URL1,fetchFn),0);
  });
  assert.equal(await headPublicObject(URL1,async()=>{throw new Error('network unavailable')}),0);
});

test('object probe accepts a current image from HEAD without a fallback request', async () => {
  const calls=[];
  const result=await headPublicObject(URL1,async (_url,init)=>{calls.push(init.method);return new Response(null,{status:200});});
  assert.equal(result,200); assert.deepEqual(calls,['HEAD']);
});

test('gateway rejects missing, foreign, malformed and null origins and foreign/missing hosts before forwarding', async t => {
  const cases=[['missing origin',{},403],['foreign origin',{origin:'https://evil.test'},403],['malformed origin',{origin:'http://127.0.0.1:4200.evil'},403],['null origin',{origin:'null'},403],['foreign host',{host:'evil.test'},403],['empty host',{host:''},403]];
  for(const [name,headers,status] of cases) await t.test(name,async()=>{
    const stub=gatewayStub(); const app=await openGateway(stub);
    try { const r=await fetch(`${app.base}/api/products`,{headers}); assert.equal(r.status,status); assert.equal(stub.calls.length,0); }
    finally { await app.close(); }
  });
  const stub=gatewayStub(); const app=await openGateway(stub);
  try { const response=await fetch(`${app.base}/api/products`,{headers:{origin:ORIGIN,host:`127.0.0.1:${app.gateway.server.address().port}`}}); assert.equal(response.status,200); assert.equal(stub.calls[0].port,43000); }
  finally { await app.close(); }
});

test('gateway rejects a request with no Host header', async () => {
  const stub=gatewayStub(); const app=await openGateway(stub);
  try {
    const result=await new Promise((resolve,reject)=>{const req=httpRequest(app.base,{method:'GET',setHost:false,headers:{origin:ORIGIN}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
    assert.equal(result,400); assert.equal(stub.calls.length,0);
  } finally { await app.close(); }
});

test('OPTIONS permits only the storefront origin and limited methods/headers', async () => {
  const app=await openGateway();
  try {
    const good=await fetch(`${app.base}/api/admin/products`,{method:'OPTIONS',headers:{origin:ORIGIN,'access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}});
    const bad=await fetch(`${app.base}/api/admin/products`,{method:'OPTIONS',headers:{origin:ORIGIN,'access-control-request-method':'PATCH','access-control-request-headers':'authorization'}});
    assert.equal(good.status,204); assert.equal(bad.status,403);
  } finally { await app.close(); }
});

test('gateway permits mocked upload, replacement, then removal for only its bound product', async () => {
  const stub=gatewayStub();
  const missingObjectFetch=async (_url,init)=>init.method==='HEAD'
    ? new Response(null,{status:400,headers:{'content-type':'application/json; charset=utf-8','content-length':'88'}})
    : new Response(JSON.stringify({statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'}),{status:400,headers:{'content-type':'application/json; charset=utf-8'}});
  const app=await openGateway(stub,{imageHead:url=>headPublicObject(url,missingObjectFetch)});
  const upload=()=>fetch(`${app.base}/api/admin/products/${ID}/image`,{method:'POST',headers:authHeaders({'content-type':'multipart/form-data; boundary=x'}),body:'--x\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nabc\r\n--x--\r\n'});
  try {
    assert.equal((await postProduct(app)).status,201);
    assert.equal((await upload()).status,200); assert.equal(app.gateway.state().image,URL1);
    assert.equal((await upload()).status,200); assert.equal(app.gateway.state().image,URL2); assert.equal(stub.state().storage.has(URL1),false);
    const removed=await fetch(`${app.base}/api/admin/products/${ID}/image`,{method:'DELETE',headers:authHeaders()});
    assert.equal(removed.status,200); assert.equal(app.gateway.state().image,''); assert.equal(stub.state().storage.size,0);
  } finally { await app.close(); }
});

test('GET traffic and login remain routed through the read-only guard', async () => {
  const stub=gatewayStub(); const app=await openGateway(stub);
  try {
    const a=await fetch(`${app.base}/api/products`,{headers:{origin:ORIGIN}});
    const b=await fetch(`${app.base}/api/admin/login`,{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:'{}'});
    assert.equal(a.status,200); assert.equal(b.status,401); assert.deepEqual(stub.calls.map(x=>x.port),[43000,43000]);
  } finally { await app.close(); }
});

test('concurrent creation is serialized before asynchronous preflight and creates at most one product', async () => {
  let release; const delayed=new Promise(r=>release=r); const stub=gatewayStub({readDelay:delayed}); const app=await openGateway(stub);
  try {
    const first=postProduct(app); await new Promise(r=>setTimeout(r,10));
    const second=await postProduct(app); assert.equal(second.status,409); release();
    assert.equal((await first).status,201); assert.equal(stub.state().createCalls,1);
    const third=await postProduct(app); assert.equal(third.status,403); assert.equal(stub.state().createCalls,1);
  } finally { release(); await app.close(); }
});

test('gateway restart with a bound product preserves one-product lock', async () => {
  const store=createMemoryStateStore({status:'ready'}); const stub=gatewayStub(); const first=await openGateway(stub,{store});
  try { assert.equal((await postProduct(first)).status,201); } finally { await first.close(); }
  const second=await openGateway(stub,{store});
  try { assert.equal((await postProduct(second)).status,403); assert.equal(stub.state().createCalls,1); } finally { await second.close(); }
});

test('pending creation on restart reconciles by read only and never replays create', async () => {
  const pending={status:'creating',sku:SKU,productName:NAME,pending:{body:{sku:SKU,name:NAME,description:'',brand:'TOTAL',category:'Power Tools',price:0,stock:0,image:'',label:'',active:false}}};
  const store=createMemoryStateStore(pending); const stub=gatewayStub();
  // A committed row is visible to the GET reconciliation but no new POST is sent.
  stub.requestFn=async req=>{ if(req.port===43000 && req.path==='/api/admin/products') return response(200,{products:[product()]}); return response(500,{}); };
  const app=await openGateway(stub,{store});
  try { const r=await postProduct(app); assert.equal(r.status,423); assert.equal(stub.calls.some(x=>x.port===43001),false); assert.equal(app.gateway.state().productId,ID); }
  finally { await app.close(); }
});

test('pending image operation on restart becomes uncertain and cannot be replayed', async () => {
  const pending={status:'image_pending',sku:SKU,productId:ID,productName:NAME,image:URL1,pending:{operation:'replace',previousImage:URL1,expectedImage:null,startedAt:Date.now()}};
  const store=createMemoryStateStore(pending);const stub=gatewayStub();
  stub.requestFn=async req=>{if(req.port===43000&&req.path==='/api/admin/products')return response(200,{products:[product({image:URL1})]});return response(500,{});};
  const app=await openGateway(stub,{store});
  try {const result=await postProduct(app);assert.equal(result.status,423);assert.equal(app.gateway.state().status,'uncertain');assert.equal(stub.calls.some(c=>c.port===43001),false);}
  finally {await app.close();}
});

test('corrupt or missing persistent state fails closed at startup', async () => {
  const store={async acquire(){return true},async load(){throw Error('corrupt')},async release(){},async save(){}};
  const gateway=createTestGateway({stateStore:store,logger:QUIET}); await assert.rejects(gateway.start(),/gateway_state_missing_or_corrupt/);
});

test('persistent state initializes once, locks one runtime, survives restart, and rejects corruption', async () => {
  const root=resolve(process.cwd(),'.product-image-test-run');
  const temp=await mkdtemp(join(root,'phase2.1-state-test-'));
  try {
    const path=join(temp,'state.json');const first=createFileStateStore(path,{projectRoot:temp,markerRoot:temp});
    assert.equal(await first.initialize(),true);assert.equal(await first.initialize(),false);
    assert.equal((await first.load()).status,'ready');assert.equal(await first.acquire(),true);
    const second=createFileStateStore(path,{projectRoot:temp,markerRoot:temp});assert.equal(await second.acquire(),false);
    await first.save({status:'creating',sessionId:(await first.load()).sessionId,sku:SKU,productName:NAME,pending:{body:{sku:SKU,name:NAME,description:'',brand:'TOTAL',category:'Power Tools',price:0,stock:0,image:'',label:'',active:false},startedAt:Date.now()}});
    await first.release();
    assert.equal((await second.load()).status,'creating');
    await writeFile(path,'{broken');await assert.rejects(second.load());
  } finally { await removeTestTemp(temp); }
});

test('one-time initializer refuses deleted, corrupt, or inconsistent session state', async t => {
  const root=resolve(process.cwd(),'.product-image-test-run');const temp=await mkdtemp(join(root,'phase2.3-initialize-regression-'));
  try {
    await t.test('state missing while marker remains',async()=>{
      const path=join(temp,'missing-state.json');const marker=join(temp,'marker-missing-state','state.marker');const store=createFileStateStore(path,{projectRoot:temp,markerRoot:temp,markerPath:marker});
      assert.equal(await store.initialize(),true);await store.save({status:'uncertain',sessionId:(await store.load()).sessionId,sku:SKU,productId:ID,productName:NAME,pending:{operation:'create',startedAt:Date.now()}});await unlink(path);
      const replacement=createFileStateStore(path,{projectRoot:temp,markerRoot:temp,markerPath:marker});await assert.rejects(replacement.initialize(),/gateway_state_initialization_inconsistent_manual_recovery_required/);await assert.rejects(replacement.load());
    });
    await t.test('marker missing while state remains',async()=>{
      const path=join(temp,'missing-marker.json');const marker=join(temp,'marker-missing-marker','state.marker');const store=createFileStateStore(path,{projectRoot:temp,markerRoot:temp,markerPath:marker});assert.equal(await store.initialize(),true);spawnSync('icacls.exe',[dirname(marker),'/reset','/T','/C','/Q'],{windowsHide:true,stdio:'ignore'});await unlink(marker);
      const replacement=createFileStateStore(path,{projectRoot:temp,markerRoot:temp,markerPath:marker});await assert.rejects(replacement.initialize(),/gateway_state_initialization_inconsistent_manual_recovery_required/);await assert.rejects(replacement.load());
    });
    await t.test('marker corruption fails closed and cannot reset',async()=>{
      const path=join(temp,'corrupt-marker.json');const marker=join(temp,'marker-corrupt-marker','state.marker');const store=createFileStateStore(path,{projectRoot:temp,markerRoot:temp,markerPath:marker});assert.equal(await store.initialize(),true);
      await assert.rejects(unlink(marker),error=>error.code==='EPERM');
      spawnSync('icacls.exe',[marker,'/grant',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`],{windowsHide:true,stdio:'ignore'});await writeFile(marker,'{broken');
      const replacement=createFileStateStore(path,{projectRoot:temp,markerRoot:temp,markerPath:marker});assert.equal(await replacement.initialize(),false);await assert.rejects(replacement.load());
    });
  } finally { await removeTestTemp(temp); }
});

test('named operating-system mutex permits only one runtime and releases with its owner', async () => {
  const root=resolve(process.cwd(),'.product-image-test-run');const temp=await mkdtemp(join(root,'phase2.3-lock-regression-'));
  try {
    const path=join(temp,'state.json');const options={projectRoot:temp,markerRoot:temp,markerPath:join(temp,'marker-lock','state.marker')};const first=createFileStateStore(path,options);const second=createFileStateStore(path,options);await first.initialize();
    assert.equal(await first.acquire(),true);assert.equal(await second.acquire(),false);
    await first.release();assert.equal(await second.acquire(),true);await second.release();
  } finally { await removeTestTemp(temp); }
});

test('expiry drains in-flight request before releasing mutex to another runtime', async () => {
  const root=resolve(process.cwd(),'.product-image-test-run');const temp=await mkdtemp(join(root,'phase2.3-expiry-regression-'));let releaseFirstRead;let firstReadStarted;const firstReadSignal=new Promise(resolve=>firstReadStarted=resolve);const firstReadGate=new Promise(resolve=>releaseFirstRead=resolve);const products=[];const created=[];let productReads=0;
  const requestFn=async req=>{
    if(req.port===43000){
      if(req.path==='/api/admin/products') {productReads++;if(productReads===1){firstReadStarted();await firstReadGate;}return response(200,{products:[...products]});}
      if(req.path==='/api/admin/categories')return response(200,{categories:[{name:'Power Tools',active:true}]});
      if(req.path==='/api/admin/brands')return response(200,{brands:[{name:'TOTAL',active:true}]});
    }
    if(req.port===43001&&req.method==='POST'&&req.path==='/api/admin/products'){
      const body=JSON.parse(req.body.toString());const id=body.sku===SKU?ID:OTHER_ID;const value={...body,id,active:false,stock:0};products.push(value);created.push(value.sku);return response(201,{product:value});
    }
    throw Error('unexpected mocked request');
  };
  let first;let second;
  try{
    const statePath=join(temp,'state.json');const storeOptions={projectRoot:temp,markerRoot:temp,markerPath:join(temp,'marker-expiry','state.marker')};const firstStore=createFileStateStore(statePath,storeOptions);await firstStore.initialize();
    first=createTestGateway({requestFn,stateStore:firstStore,port:0,guardPort:43000,backendPort:43001,lifetimeMs:200,logger:QUIET});await first.start();await new Promise(resolve=>first.server.listen(0,'127.0.0.1',resolve));
    const send=(gateway,sku)=>fetch(`http://127.0.0.1:${gateway.server.address().port}/api/admin/products`,{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({sku,name:NAME,description:'',brand:'TOTAL',category:'Power Tools',price:0,stock:0,image:'',label:'',inventoryReason:'',active:false})});
    const firstRequest=send(first,SKU);await firstReadSignal;await new Promise(resolve=>setTimeout(resolve,350));
    second=createTestGateway({requestFn,stateStore:createFileStateStore(statePath,storeOptions),port:0,guardPort:43000,backendPort:43001,lifetimeMs:20_000,logger:QUIET});
    await assert.rejects(second.start(),/gateway_state_lock_exists/);
    releaseFirstRead();const firstResponse=await firstRequest;assert.equal(firstResponse.status,201);assert.deepEqual(created,[SKU]);
    await new Promise(resolve=>setTimeout(resolve,100));await second.start();await new Promise(resolve=>second.server.listen(0,'127.0.0.1',resolve));
    const secondResponse=await send(second,'IMGTEST-20261121-ZY98QWER');assert.equal(secondResponse.status,403);assert.deepEqual(created,[SKU]);
  }finally{releaseFirstRead?.();if(first)await first.close().catch(()=>{});if(second)await second.close().catch(()=>{});await removeTestTemp(temp);}
});

test('ambiguous create response binds only after exact readback and never retries create', async () => {
  const stub=gatewayStub({ambiguousCreate:true}); const app=await openGateway(stub);
  try { const r=await postProduct(app); assert.equal(r.status,409); assert.equal(stub.state().createCalls,1); assert.equal(app.gateway.state().productId,ID); }
  finally { await app.close(); }
});

test('ambiguous image POST marks state uncertain and blocks later writes', async () => {
  const stub=gatewayStub({ambiguousImage:true}); const app=await openGateway(stub);
  try {
    assert.equal((await postProduct(app)).status,201);
    const boundary='x'; const body=`--x\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nabc\r\n--x--\r\n`;
    const upload=await fetch(`${app.base}/api/admin/products/${ID}/image`,{method:'POST',headers:authHeaders({'content-type':`multipart/form-data; boundary=${boundary}`}),body});
    assert.equal(upload.status,502); assert.equal(app.gateway.state().status,'uncertain');
    assert.equal((await postProduct(app)).status,423);
  } finally { await app.close(); }
});

test('ambiguous image DELETE marks state uncertain and blocks later writes', async () => {
  const stub=gatewayStub({ambiguousDelete:true}); const app=await openGateway(stub);
  try {
    await postProduct(app);
    const body=`--x\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nabc\r\n--x--\r\n`;
    await fetch(`${app.base}/api/admin/products/${ID}/image`,{method:'POST',headers:authHeaders({'content-type':'multipart/form-data; boundary=x'}),body});
    const remove=await fetch(`${app.base}/api/admin/products/${ID}/image`,{method:'DELETE',headers:authHeaders()});
    assert.equal(remove.status,502); assert.equal(app.gateway.state().status,'uncertain');
    assert.equal((await jsonRequest(app,'PUT',`/api/admin/products/${ID}`,product())).status,423);
  } finally { await app.close(); }
});

test('unrelated methods, IDs, SKUs, stock and publication state fail closed', async t => {
  for(const [name,method,path,body] of [
    ['other method','PATCH',`/api/admin/products/${OTHER_ID}`,{}],['other product','PUT',`/api/admin/products/${OTHER_ID}`,product()],
    ['real sku','POST','/api/admin/products',product({sku:REAL_SKU})],['stock','POST','/api/admin/products',product({stock:1})],['published','POST','/api/admin/products',product({active:true})]
  ]) await t.test(name,async()=>{ const stub=gatewayStub(); const app=await openGateway(stub); try { const r=await jsonRequest(app,method,path,body); assert.equal(r.status,403); assert.equal(stub.calls.some(c=>c.port===43001),false); } finally { await app.close(); } });
});

test('unrelated image upload and deletion routes never reach the write upstream', async t => {
  for (const [name, method] of [['foreign image upload','POST'],['foreign image delete','DELETE']]) await t.test(name,async()=>{
    const stub=gatewayStub();const app=await openGateway(stub);
    try {
      const headers=authHeaders(method==='POST'?{'content-type':'multipart/form-data; boundary=x'}:{});
      const body=method==='POST'?'--x\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nabc\r\n--x--\r\n':undefined;
      const result=await fetch(`${app.base}/api/admin/products/${OTHER_ID}/image`,{method,headers,...(body===undefined?{}:{body})});
      assert.equal(result.status,403);assert.equal(stub.calls.some(call=>call.port===43001),false);
    } finally { await app.close(); }
  });
});

test('image deletion with a request body and unexpected creation fields fail closed', async t => {
  const stub=gatewayStub();const app=await openGateway(stub);
  try {
    const create=await postProduct(app,{unexpected:'value'});assert.equal(create.status,403);assert.equal(stub.state().createCalls,0);
    assert.equal((await postProduct(app)).status,201);
    const remove=await fetch(`${app.base}/api/admin/products/${ID}/image`,{method:'DELETE',headers:authHeaders({'content-type':'application/json'}),body:'{}'});
    assert.equal(remove.status,413);assert.equal(stub.calls.some(call=>call.port===43001&&call.method==='DELETE'),false);
  } finally { await app.close(); }
});

test('quote snapshot detects exact, escaped, percent-encoded and normalized URL representations', () => {
  const cases=[URL1,URL1.replaceAll('/','\\/'),URL1.replace('/products/','/%70roducts/'),URL1.replace('https://','HTTPS://').replace('ipegazjnkejasorskdur.supabase.co','IPEGazjnkejasorskdur.SUPABASE.CO')];
  for(const value of cases) { const r=inspectQuoteSnapshotImageReference([{products:`image reference ${value}`}],URL1); assert.equal(r.referenced,true,value); }
  const fullyEncoded=encodeURIComponent(URL1); assert.equal(inspectQuoteSnapshotImageReference([{products:fullyEncoded}],URL1).referenced,true);
  const unicodeEscaped=URL1.replaceAll('/','\\u002f').replaceAll(':','\\u003a'); assert.equal(inspectQuoteSnapshotImageReference([{products:unicodeEscaped}],URL1).referenced,true);
});

test('case-variant path, malformed encoding and historical ambiguity all block deletion', () => {
  const values=[URL1.replace('4fb05c3e','4FB05C3E'),URL1.replace('4fb05c3e','4fb05c3e%ZZ'),'old quote product-images path products/4d9319f3-47a6-4b65-9abd-113b4acd1f71/4fb05c3e'];
  for(const value of values) { const r=inspectQuoteSnapshotImageReference([{products:value}],URL1); assert.equal(r.ambiguous,true,value); }
  assert.equal(inspectQuoteSnapshotImageReference([{products:null}],URL1).inspectable,false);
  let deep=URL1; for(let i=0;i<20;i++) deep=encodeURIComponent(deep);
  assert.equal(inspectQuoteSnapshotImageReference([{products:deep}],URL1).ambiguous,true);
});

test('different object is not a reference; product null image values are inspectable', () => {
  const other=URL1.replace(OBJ1,OBJ2); assert.equal(inspectQuoteSnapshotImageReference([{products:other}],URL1).referenced,false);
  assert.equal(inspectStorageUrlReferenceValues([null,'',other],URL1).referenced,false);
  assert.equal(inspectStorageUrlReferenceValues([42],URL1).ambiguous,true);
});

test('cleanup refuses order, inventory, shared image, quote URL and malformed reference pages', async t => {
  const checks=[['orders',{orders:[{id:'o'}]}],['inventory',{movements:[{id:'m'}]},'movement'],['shared URL',{imageRefs:[URL1]}],['quote URL',{quotes:[{products:`legacy ${URL1}`}]}],['malformed FK',{fks:null}]];
  for(const [name,override] of checks) await t.test(name,async()=>{ const {client,state}=cleanupClient(override); const result=await cleanRun(client); assert.equal(result.safe,false); assert.equal(state.writes.length,0); });
});

test('cleanup refuses escaped, encoded and equivalent quote URL representations', async t => {
  const variants=[URL1.replaceAll('/','\\/'),encodeURIComponent(URL1),URL1.replace('/products/','/%70roducts/')];
  for(const [i,url] of variants.entries()) await t.test(`representation ${i+1}`,async()=>{const {client,state}=cleanupClient({quotes:[{products:`archived snapshot ${url}`}]});const result=await cleanRun(client);assert.equal(result.safe,false);assert.equal(state.writes.length,0);});
});

test('cleanup exact identity, expected name, unpublished and zero stock are mandatory', async t => {
  const cases=[['wrong UUID','bad',SKU],['wrong SKU',ID,'IMGTEST-OTHER-ABCD1234'],['wrong name',ID,SKU,{product:product({name:'real'})}],['published',ID,SKU,{product:product({active:true})}],['stock',ID,SKU,{product:product({stock_quantity:1})}]];
  for(const [name,id,sku,overrides={}] of cases) await t.test(name,async()=>{const {client,state}=cleanupClient(overrides);const result=await runCleanup({client,projectUrl:PROJECT,productId:id,sku,confirmation:`${id}:${sku}`});assert.equal(result.safe,false);assert.equal(state.writes.length,0);});
});

test('storage paths outside exact UUID filename prefix and unexpected references are refused', async t => {
  for(const object of [`products/${OTHER_ID}/4fb05c3e-e518-48f0-9b1a-076ef09027bc.png`,`products/${ID}/nested/4fb05c3e-e518-48f0-9b1a-076ef09027bc.png`]) {
    const {client,state}=cleanupClient({objects:[object]});const result=await cleanRun(client);assert.equal(result.safe,false);assert.equal(state.writes.length,0);
  }
});

test('dry-run never writes; cleanup removes each object before product and reports exact result', async () => {
  const {client,state}=cleanupClient(); const dry=await runCleanup({client,projectUrl:PROJECT,productId:ID,sku:SKU}); assert.equal(dry.dryRun,true);assert.equal(state.writes.length,0);
  const done=await cleanRun(client);assert.equal(done.safe,true);assert.equal(done.productStillExists,false);assert.equal(done.productDeleteOutcome,'confirmed_by_response_and_readback');
  assert.deepEqual(state.writes,[['object',OBJ1],['product',ID,SKU]]);assert.deepEqual(done.deletedObjectPaths,[OBJ1]);assert.deepEqual(done.remainingObjectPaths,[]);
});

test('wrong confirmation never writes and is bound to the exact UUID and SKU', async () => {
  const {client,state}=cleanupClient();const result=await runCleanup({client,projectUrl:PROJECT,productId:ID,sku:SKU,confirmation:`${OTHER_ID}:${SKU}`});assert.equal(result.dryRun,true);assert.equal(state.writes.length,0);
});

test('Storage pagination accepts exactly 100 then continues and advances by returned count', async () => {
  const {createClientForTest}=await import('./cleanup-product-image-test.mjs');
  // Exercise the exported pagination adapter with a deterministic HTTP stub.
  const pages=[]; for(let i=0;i<100;i++) pages.push({name:`${i.toString().padStart(3,'0')}.png`});
  const client=createClientForTest({projectUrl:PROJECT,serviceKey:'mock-only-never-sent',fetchFn:async(_url,options)=>{const body=JSON.parse(options.body);return new Response(JSON.stringify(body.offset===0?pages:[{name:'last.png'}]),{status:200});}});
  const listed=await client.listProductObjects(`products/${ID}/`);assert.equal(listed.length,101);
});

test('Storage listing rejects repeated paths and malformed list responses', async t => {
  const {createClientForTest}=await import('./cleanup-product-image-test.mjs');
  for(const [name,fetchFn] of [
    ['repeated path',async(_url,options)=>{const body=JSON.parse(options.body);const page=body.offset===0?Array.from({length:100},(_,i)=>({name:i===99?'same.png':`n${i}.png`})):[{name:'same.png'}];return new Response(JSON.stringify(page),{status:200});}],
    ['malformed page',async()=>new Response(JSON.stringify({items:[]}),{status:200})]
  ]) await t.test(name,async()=>{const client=createClientForTest({projectUrl:PROJECT,serviceKey:'mock-only',fetchFn});await assert.rejects(client.listProductObjects(`products/${ID}/`));});
});

test('repeated or malformed Storage pages and malformed business references abort without writes', async t => {
  const repeated=cleanupClient(); repeated.client.listProductObjects=async()=>{throw Error('storage_list_repeated_page');};
  const malformed=cleanupClient(); malformed.client.findRows=async()=>({not:'array'});
  for(const [name,fixture] of [['repeated objects',repeated],['malformed references',malformed]]) await t.test(name,async()=>{const result=await cleanRun(fixture.client);assert.equal(result.safe,false);assert.equal(fixture.state.writes.length,0);});
});

test('cleanup distinguishes unobserved, confirmed absent, and failed inspections', async t => {
  await t.test('product read failure is inspection_failed and preserves unknown object state',async()=>{
    const fixture=cleanupClient();fixture.client.getProduct=async()=>{throw Error('read_failed');};
    const result=await inspectCleanup({client:fixture.client,projectUrl:PROJECT,productId:ID,sku:SKU});
    assert.equal(result.safe,false);assert.equal(result.productStatus,'inspection_failed');assert.equal(result.objectPathsStatus,'unknown');assert.equal(result.product,null);assert.equal(result.objectPaths,null);
    const report=await runCleanup({client:fixture.client,projectUrl:PROJECT,productId:ID,sku:SKU,confirmation:`${ID}:${SKU}`});assert.equal(report.productStillExists,null);assert.equal(report.remainingObjectPaths,null);assert.equal(fixture.state.writes.length,0);
  });
  await t.test('Storage inspection failure preserves observed product and unknown object list',async()=>{
    const fixture=cleanupClient();fixture.client.listProductObjects=async()=>{throw Error('storage_unavailable');};
    const result=await inspectCleanup({client:fixture.client,projectUrl:PROJECT,productId:ID,sku:SKU});
    assert.equal(result.safe,false);assert.equal(result.productStatus,'present');assert.equal(result.objectPathsStatus,'inspection_failed');assert.equal(result.product.id,ID);assert.equal(result.objectPaths,null);
  });
  await t.test('confirmed absence is explicit and never mistaken for an unknown object listing',async()=>{
    const fixture=cleanupClient({product:null,objects:[]});
    const result=await inspectCleanup({client:fixture.client,projectUrl:PROJECT,productId:ID,sku:SKU});
    assert.equal(result.productStatus,'confirmed_absent');assert.equal(result.objectPathsStatus,'confirmed_absent');assert.equal(result.safe,false);
  });
});

test('Storage readback failure after an object delete never proceeds to product deletion', async()=>{
  const fixture=cleanupClient();let calls=0;fixture.client.listProductObjects=async()=>{calls++;if(calls>=3)throw Error('storage_readback_failed');return fixture.state.objects;};
  const result=await cleanRun(fixture.client);
  assert.equal(result.safe,false);assert.equal(result.productStatus,'present');assert.equal(result.objectPathsStatus,'inspection_failed');assert.equal(result.remainingObjectPaths,null);assert.deepEqual(result.objectDeleteAttempts,[{path:OBJ1,status:'inspection_failed'}]);assert.equal(result.productDeleteAttempted,false);assert.deepEqual(fixture.state.writes,[['object',OBJ1]]);
});

test('failed or ambiguous Storage deletion retains product and reports remaining paths', async t => {
  for(const outcome of ['throw','ambiguous']) await t.test(outcome,async()=>{const {client,state}=cleanupClient({objectDeleteResult:outcome});const result=await cleanRun(client);assert.equal(result.safe,false);assert.equal(result.productStillExists,true);assert.deepEqual(result.remainingObjectPaths,[OBJ1]);assert.equal(result.productDeleteAttempted,false);assert.deepEqual(state.writes,[['object',OBJ1]]);});
});

test('product delete failure and ambiguous outcome are read back without expanding scope', async t => {
  for(const outcome of ['throw','ambiguous']) await t.test(outcome,async()=>{const {client,state}=cleanupClient({objects:[],productDeleteResult:outcome});const result=await cleanRun(client);assert.equal(result.safe,false);assert.equal(result.productStillExists,true);assert.equal(result.productDeleteAttempted,true);assert.deepEqual(state.writes,[['product',ID,SKU]]);});
});

test('ambiguous product-delete response is confirmed only by exact readback', async () => {
  const {client,state}=cleanupClient({objects:[],productDeleteResult:'ambiguous'});
  client.deleteProductExact=async(id,sku)=>{state.writes.push(['product',id,sku]);state.product=null;return null;};
  const result=await cleanRun(client);assert.equal(result.safe,true);assert.equal(result.productDeleteOutcome,'confirmed_by_readback');assert.equal(result.productStillExists,false);
});

test('revalidation catches a changed product or newly appearing reference before each delete', async t => {
  const changed=cleanupClient(); let gets=0; changed.client.getProduct=async()=>{gets++;if(gets>1) changed.state.product={...changed.state.product,stock_quantity:3};return changed.state.product?[changed.state.product]:[];};
  const r1=await cleanRun(changed.client);assert.equal(r1.safe,false);assert.equal(changed.state.writes.length,0);
  const shared=cleanupClient(); let checks=0; const inspect=shared.client.inspectProductImageReferences; shared.client.inspectProductImageReferences=async url=>{checks++;return checks>1?{inspectable:true,ambiguous:false,referenced:true}:inspect(url);};
  const r2=await cleanRun(shared.client);assert.equal(r2.safe,false);assert.equal(shared.state.writes.length,0);
});
