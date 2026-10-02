const express=require('express');
const crypto=require('crypto');
const {Pool}=require('pg');
const app=express();
app.use(express.json({limit:'50kb'}));

const PRICES={'وجبة كرسبي عائلية':1200000,'لفات شاورما وكرسبي طاووق':300000,'فروج على الغاز':1200000,'فروج على الفحم':1500000,'رز مندي':300000,'رز بخاري':300000,'منسف':300000,'مقلوبة':300000,'خيارة بلبن':0,'دقوس':0};
const ADMIN_PASSWORD='1234';
const DATABASE_URL=process.env.DATABASE_URL||'';
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,max:10,idleTimeoutMillis:30000,connectionTimeoutMillis:10000}):null;
const memoryOrders=[],visitors=new Map();
let uniqueVisitors=0,pageViews=0;

app.use(express.static(__dirname));
app.get('/admin',(q,s)=>s.sendFile(__dirname+'/admin.html'));
app.get('/stats',(q,s)=>s.sendFile(__dirname+'/stats.html'));
app.get('/rate',(q,s)=>s.sendFile(__dirname+'/rating.html'));
app.use((q,s,n)=>{s.setHeader('Access-Control-Allow-Origin','*');s.setHeader('Access-Control-Allow-Headers','Content-Type, X-Admin-Password');s.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');if(q.method==='OPTIONS')return s.sendStatus(204);n()});
function authorized(q){return q.get('X-Admin-Password')===ADMIN_PASSWORD}
function cleanOnline(){const now=Date.now();for(const[k,v]of visitors)if(now-v.last>30000)visitors.delete(k)}
function orderRevenue(o){return Number(o.totalPrice??((PRICES[o.item]||0)*Number(o.qty||0)))}

async function initDb(){
 if(!pool)return;
 await pool.query(`CREATE TABLE IF NOT EXISTS orders(
   id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,item TEXT NOT NULL,
   qty INTEGER NOT NULL,notes TEXT DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   status TEXT NOT NULL DEFAULT 'جديد',unit_price BIGINT NOT NULL DEFAULT 0,total_price BIGINT NOT NULL DEFAULT 0,
   rating INTEGER,rating_comment TEXT DEFAULT '',rated_at TIMESTAMPTZ,delivered_at TIMESTAMPTZ
 )`);
 await pool.query(`CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC)`);
 await pool.query(`CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS visitors(
   id TEXT PRIMARY KEY,last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),page_views INTEGER NOT NULL DEFAULT 0,last_page TEXT DEFAULT '/'
 )`);
 console.log('PostgreSQL connected');
}

function row(o){return {id:o.id,name:o.name,phone:o.phone,address:o.address,item:o.item,qty:Number(o.qty),notes:o.notes||'',createdAt:new Date(o.created_at||o.createdAt).toISOString(),status:o.status,unitPrice:Number(o.unit_price??o.unitPrice??0),totalPrice:Number(o.total_price??o.totalPrice??0),rating:o.rating===null||o.rating===undefined?null:Number(o.rating),ratingComment:o.rating_comment??o.ratingComment??'',ratedAt:o.rated_at?new Date(o.rated_at).toISOString():o.ratedAt||null,deliveredAt:o.delivered_at?new Date(o.delivered_at).toISOString():o.deliveredAt||null}}

app.get('/',(q,s)=>s.sendFile(__dirname+'/admin.html'));

app.post('/api/visit',async(q,s)=>{
 try{
  const{id,page}=q.body||{};if(!id)return s.status(400).json({error:'missing id'});const now=Date.now();
  if(pool){
   const r=await pool.query(`INSERT INTO visitors(id,last_seen,page_views,last_page) VALUES($1,NOW(),1,$2)
   ON CONFLICT(id) DO UPDATE SET last_seen=NOW(),page_views=visitors.page_views+1,last_page=EXCLUDED.last_page RETURNING (xmax=0) AS is_new`,[id,page||'/']);
   if(r.rows[0].is_new)uniqueVisitors++;
   pageViews++;
  }else{if(!visitors.has(id))uniqueVisitors++;pageViews++;visitors.set(id,{last:now,page:page||'/'});cleanOnline()}
  s.json({ok:true});
 }catch(e){console.error(e);s.status(500).json({error:'خطأ في تسجيل الزيارة'})}
});

app.get('/api/stats',async(q,s)=>{
 if(!authorized(q))return s.status(401).json({error:'غير مصرح'});
 try{
  if(!pool){
   cleanOnline();const days={},items={};let revenue=0,completed=0,sum=0,count=0;
   memoryOrders.forEach(o=>{const day=new Date(o.createdAt).toLocaleDateString('en-CA',{timeZone:'Asia/Beirut'}),amount=orderRevenue(o);revenue+=amount;if(o.status==='مكتمل'||o.status==='تم التوصيل')completed++;if(o.rating){sum+=Number(o.rating);count++}if(!days[day])days[day]={date:day,orders:0,revenue:0,items:{},completed:0};days[day].orders++;days[day].revenue+=amount;if(o.status==='مكتمل'||o.status==='تم التوصيل')days[day].completed++;days[day].items[o.item]=(days[day].items[o.item]||0)+Number(o.qty||0);items[o.item]=(items[o.item]||0)+Number(o.qty||0)});
   return s.json({uniqueVisitors,online:visitors.size,pageViews,orders:memoryOrders.length,completedOrders:completed,totalRevenue:revenue,averageRating:count?Math.round(sum/count*10)/10:0,ratingCount:count,daily:Object.values(days).sort((a,b)=>b.date.localeCompare(a.date)),items,prices:PRICES});
  }
  const [summary,days,items,vis]=await Promise.all([
   pool.query(`SELECT COUNT(*)::int AS orders,COUNT(*) FILTER(WHERE status IN ('مكتمل','تم التوصيل'))::int AS completed,
   COALESCE(SUM(total_price),0)::bigint AS revenue,COALESCE(AVG(rating) FILTER(WHERE rating IS NOT NULL),0)::numeric(10,1) AS avg_rating,
   COUNT(rating)::int AS rating_count FROM orders`),
   pool.query(`SELECT to_char(created_at AT TIME ZONE 'Asia/Beirut','YYYY-MM-DD') AS date,COUNT(*)::int AS orders,
   COUNT(*) FILTER(WHERE status IN ('مكتمل','تم التوصيل'))::int AS completed,COALESCE(SUM(total_price),0)::bigint AS revenue
   FROM orders GROUP BY 1 ORDER BY 1 DESC`),
   pool.query(`SELECT item,SUM(qty)::int AS qty,COALESCE(SUM(total_price),0)::bigint AS revenue FROM orders GROUP BY item ORDER BY qty DESC`),
   pool.query(`SELECT COUNT(*)::int AS visitors,COALESCE(SUM(page_views),0)::int AS views,COUNT(*) FILTER(WHERE last_seen>NOW()-INTERVAL '30 seconds')::int AS online FROM visitors`)
  ]);
  const daily=days.rows.map(x=>({...x,date:x.date,revenue:Number(x.revenue),items:{}}));
  const itemMap=Object.fromEntries(items.rows.map(x=>[x.item,Number(x.qty)]));
  const s0=summary.rows[0],v=vis.rows[0];
  s.json({uniqueVisitors:Number(v.visitors),online:Number(v.online),pageViews:Number(v.views),orders:Number(s0.orders),completedOrders:Number(s0.completed),totalRevenue:Number(s0.revenue),averageRating:Number(s0.avg_rating),ratingCount:Number(s0.rating_count),daily,items:itemMap,prices:PRICES});
 }catch(e){console.error(e);s.status(500).json({error:'خطأ في الإحصائيات'})}
});

app.post('/api/orders',async(q,s)=>{
 try{
  const{name,phone,address,item,qty,notes}=q.body||{};if(!name||!phone||!address||!item||!qty)return s.status(400).json({error:'البيانات ناقصة'});
  const id=crypto.randomUUID(),n=Number(qty),unit=PRICES[item]||0,total=unit*n;
  if(pool)await pool.query(`INSERT INTO orders(id,name,phone,address,item,qty,notes,status,unit_price,total_price) VALUES($1,$2,$3,$4,$5,$6,$7,'جديد',$8,$9)`,[id,name,phone,address,item,n,notes||'',unit,total]);
  else memoryOrders.unshift({id,name,phone,address,item,qty:n,notes:notes||'',createdAt:new Date().toISOString(),status:'جديد',unitPrice:unit,totalPrice:total,rating:null,ratingComment:''});
  s.status(201).json({ok:true,id,ratingUrl:'https://chicken-orders-api.onrender.com/rate?id='+encodeURIComponent(id)});
 }catch(e){console.error(e);s.status(500).json({error:'تعذر حفظ الطلب'})}
});

app.get('/api/orders',async(q,s)=>{
 if(!authorized(q))return s.status(401).json({error:'غير مصرح'});
 try{
  if(pool){const r=await pool.query('SELECT * FROM orders ORDER BY created_at DESC');return s.json(r.rows.map(row))}
  s.json(memoryOrders);
 }catch(e){console.error(e);s.status(500).json({error:'تعذر جلب الطلبات'})}
});

app.get('/api/orders/:id/public',async(q,s)=>{
 try{
  let o;
  if(pool){const r=await pool.query('SELECT * FROM orders WHERE id=$1',[q.params.id]);o=r.rows[0]&&row(r.rows[0])}else o=memoryOrders.find(x=>x.id===q.params.id);
  if(!o)return s.status(404).json({error:'غير موجود'});s.json({id:o.id,item:o.item,qty:o.qty,status:o.status,rating:o.rating});
 }catch(e){s.status(500).json({error:'خطأ'})}
});

app.post('/api/orders/:id/delivered',async(q,s)=>{
 try{
  if(pool){const r=await pool.query(`UPDATE orders SET status='تم التوصيل',delivered_at=NOW() WHERE id=$1 RETURNING *`,[q.params.id]);if(!r.rows[0])return s.status(404).json({error:'غير موجود'});return s.json(row(r.rows[0]))}
  const o=memoryOrders.find(x=>x.id===q.params.id);if(!o)return s.status(404).json({error:'غير موجود'});o.status='تم التوصيل';o.deliveredAt=new Date().toISOString();s.json(o);
 }catch(e){s.status(500).json({error:'خطأ'})}
});

app.post('/api/orders/:id/rating',async(q,s)=>{
 try{
  const rating=Number(q.body.rating),comment=String(q.body.comment||'').slice(0,500);
  if(!Number.isInteger(rating)||rating<1||rating>5)return s.status(400).json({error:'التقييم من 1 إلى 5'});
  if(pool){const r=await pool.query(`UPDATE orders SET rating=$1,rating_comment=$2,rated_at=NOW(),status='مكتمل',delivered_at=COALESCE(delivered_at,NOW()) WHERE id=$3 RETURNING id`,[rating,comment,q.params.id]);if(!r.rows[0])return s.status(404).json({error:'غير موجود'});return s.json({ok:true})}
  const o=memoryOrders.find(x=>x.id===q.params.id);if(!o)return s.status(404).json({error:'غير موجود'});o.rating=rating;o.ratingComment=comment;o.ratedAt=new Date().toISOString();o.status='مكتمل';s.json({ok:true});
 }catch(e){s.status(500).json({error:'خطأ في حفظ التقييم'})}
});

app.post('/api/orders/:id/status',async(q,s)=>{
 if(!authorized(q))return s.status(401).json({error:'غير مصرح'});
 try{
  const status=q.body.status;
  if(pool){const r=await pool.query(`UPDATE orders SET status=$1,delivered_at=CASE WHEN $1 IN ('تم التوصيل','مكتمل') THEN COALESCE(delivered_at,NOW()) ELSE delivered_at END WHERE id=$2 RETURNING *`,[status,q.params.id]);if(!r.rows[0])return s.status(404).json({error:'غير موجود'});return s.json(row(r.rows[0]))}
  const o=memoryOrders.find(x=>x.id===q.params.id);if(!o)return s.status(404).json({error:'غير موجود'});o.status=status||o.status;if(o.status==='تم التوصيل'||o.status==='مكتمل')o.deliveredAt=new Date().toISOString();s.json(o);
 }catch(e){s.status(500).json({error:'خطأ'})}
});

initDb().then(()=>app.listen(process.env.PORT||10000,'0.0.0.0',()=>console.log('Chicken orders API running'))).catch(e=>{console.error('Database startup failed',e);process.exit(1)});
