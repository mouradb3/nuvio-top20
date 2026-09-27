import http from "http";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7000);
const TMDB = process.env.TMDB_API_KEY;
const TRAKT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_TOKEN = process.env.TRAKT_ACCESS_TOKEN;
const TRAKT_USER = process.env.TRAKT_USERNAME;
const AI_KEY = process.env.OPENAI_API_KEY;
const AI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const AI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const CACHE_MS = Math.max(180, Number(process.env.CACHE_MINUTES || 180)) * 60_000;
const EXCLUDE_INDIA = String(process.env.EXCLUDE_INDIA || "true") !== "false";
const LOOKBACK = Number(process.env.FR_RELEASE_LOOKBACK_DAYS || 90);
const LOOKAHEAD = Number(process.env.FR_RELEASE_LOOKAHEAD_DAYS || 30);
const PAGE_SIZE = 20;
const cache = new Map();
const metaCache = new Map();

const POSTERS_PLUS = "https://postersplus.slokker.cc/poster";
const POSTERS_PARAMS = {
  primary_client:"stremio_tv_nuvio", top_gradient:"medium", sash_mode:"notch",
  landscape_sash_mode:"sash", badge_pos:"top_left", fallback_to_imdb:"true",
  rating_display_mode:"2", score_out_of_10:"true",
  movie_weights:"tomatoes:0.20,popcorn:0.20,imdb:0.60",
  tv_weights:"trakt:0.30,imdb:0.70",
  anime_movie_weights:"myanimelist:0.20,anilist:0.20,kitsu:0.20,trakt:0.10,imdb:0.30",
  anime_tv_weights:"myanimelist:0.20,anilist:0.20,kitsu:0.20,trakt:0.10,imdb:0.30",
  logo_language:"fr", logo_priority:"native_if_original_english", fallback_bg_style:"photoreal",
  sash_badge_size_w:"1.40", sash_badge_size_h:"1.20", sash_badge_inset:"0.000", badge_min_score:"5"
};

function today(){ return new Date().toISOString().slice(0,10); }
function dateShift(n){ const d=new Date(); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function uniq(xs){ const m=new Map(); for(const x of xs||[]) if(x?.id) m.set(x.id,x); return [...m.values()]; }
function getCache(key){ const x=cache.get(key); return x && Date.now()-x.t<CACHE_MS ? x.v : null; }
function setCache(key,v){ cache.set(key,{t:Date.now(),v}); return v; }
async function jsonFetch(url, options={}){
  const r=await fetch(url,options); if(!r.ok) throw new Error(`${r.status} ${url}`); return r.json();
}
function tmdb(endpoint, params={}){
  if(!TMDB) throw new Error("TMDB_API_KEY is not configured");
  const u=new URL(`https://api.themoviedb.org/3${endpoint}`); u.searchParams.set("api_key",TMDB);
  for(const [k,v] of Object.entries(params)) if(v!==undefined&&v!==null&&v!=="") u.searchParams.set(k,String(v));
  return jsonFetch(u);
}
function postersUrl({tmdbId, imdbId, id, type, shape="poster"}){
  const u=new URL(POSTERS_PLUS);
  const p={...POSTERS_PARAMS, tmdb_id:tmdbId||undefined, imdb_id:imdbId||undefined, stremio_id:id, type, shape};
  for(const [k,v] of Object.entries(p)) if(v!==undefined) u.searchParams.set(k,v);
  return u.toString();
}
async function externalIds(type,id){
  const key=`ids:${type}:${id}`; const c=getCache(key); if(c) return c;
  try{return setCache(key,await tmdb(`/${type}/${id}/external_ids`));}catch{return {};}
}
async function detail(type,id){
  const key=`detail:${type}:${id}`; const c=getCache(key); if(c) return c;
  try{return setCache(key,await tmdb(`/${type}/${id}`,{language:"fr-FR",append_to_response:"external_ids"}));}catch{return {};}
}
async function toMeta(x,type,rank){
  const d=await detail(type,x.id); const imdb=d.external_ids?.imdb_id || (await externalIds(type,x.id)).imdb_id;
  const title=x.title||x.name||d.title||d.name||x.original_title||x.original_name;
  const date=x.release_date||x.first_air_date||d.release_date||d.first_air_date;
  const id=imdb || `${type}:${x.id}`;
  return {
    id, type, name:title,
    poster:postersUrl({tmdbId:x.id,imdbId:imdb,id,type,shape:"poster"}),
    background:postersUrl({tmdbId:x.id,imdbId:imdb,id,type,shape:"landscape"}),
    description:x.overview||d.overview,
    releaseInfo:date?.slice(0,10),
    imdbRating:x.vote_average?Number(x.vote_average.toFixed(1)):undefined,
    posterShape:"poster",
    rank
  };
}
async function parallelMap(items, fn, concurrency=8){
  const out=new Array(items.length); let next=0;
  async function worker(){ while(true){ const i=next++; if(i>=items.length)return; try{out[i]=await fn(items[i],i);}catch{out[i]=null;} } }
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},worker)); return out.filter(Boolean);
}
async function discoverAll(pathname, params, maxPages=50){
  const out=[];
  for(let page=1;page<=maxPages;page++){
    const d=await tmdb(pathname,{...params,page}); out.push(...(d.results||[]));
    if(!d.total_pages || page>=d.total_pages) break;
  }
  return uniq(out);
}
async function discoverMovies(params,maxPages=50){return discoverAll("/discover/movie",{language:"fr-FR",region:"FR",include_adult:false,include_video:false,...params},maxPages);}
async function discoverTV(params,maxPages=50){return discoverAll("/discover/tv",{language:"fr-FR",watch_region:"FR",include_adult:false,...params},maxPages);}
async function filterIndiaMovies(items){
  if(!EXCLUDE_INDIA)return items;
  return (await parallelMap(items,async x=>{
    const d=await detail("movie",x.id); const countries=(d.production_countries||[]).map(c=>c.iso_3166_1); return countries.includes("IN")?null:x;
  },12));
}

// Top 20 France: TMDB daily-trending data is global; for a France-specific rail we use TMDB popularity
// with French release/availability context and refresh the result every cache interval.
async function top20(type){
  const key=`top20:${type}`; const c=getCache(key); if(c)return c;
  const items=type==="movie"
    ? await discoverMovies({sort_by:"popularity.desc",watch_region:"FR",with_watch_monetization_types:"flatrate|free|ads|rent|buy",vote_count_gte:5},5)
    : await discoverTV({sort_by:"popularity.desc",with_watch_monetization_types:"flatrate|free|ads|rent|buy",vote_count_gte:5},5);
  return setCache(key,items.slice(0,20));
}

async function franceMovieReleases(){
  const key="fr:movieReleases"; const c=getCache(key); if(c)return c;
  // region=FR + release types makes TMDB use French regional release dates.
  const items=await discoverMovies({
    "release_date.gte":dateShift(-LOOKBACK), "release_date.lte":dateShift(LOOKAHEAD),
    with_release_type:"4|5", sort_by:"release_date.desc"
  },50);
  return setCache(key,await filterIndiaMovies(items));
}
async function franceSeriesReleases(){
  const key="fr:seriesReleases"; const c=getCache(key); if(c)return c;
  const items=await discoverTV({
    "air_date.gte":dateShift(-LOOKBACK), "air_date.lte":dateShift(LOOKAHEAD),
    sort_by:"first_air_date.desc", with_watch_monetization_types:"flatrate|free|ads|rent|buy"
  },50);
  return setCache(key,items);
}

const dataDir=path.join(__dirname,"data"); const ratingsFile=path.join(dataDir,"title.ratings.tsv"); const basicsFile=path.join(dataDir,"title.basics.tsv");
function download(url,dest){return new Promise((resolve,reject)=>{fs.mkdirSync(path.dirname(dest),{recursive:true});https.get(url,res=>{if(res.statusCode!==200)return reject(new Error(`HTTP ${res.statusCode}`));const out=fs.createWriteStream(dest);res.pipe(out);out.on("finish",()=>out.close(resolve));}).on("error",reject);});}
function gunzip(src,dst){return new Promise((resolve,reject)=>fs.createReadStream(src).pipe(zlib.createGunzip()).pipe(fs.createWriteStream(dst)).on("finish",()=>{try{fs.unlinkSync(src)}catch{}resolve();}).on("error",reject));}
async function ensureImdbFiles(){
  if(!fs.existsSync(ratingsFile)) await download("https://datasets.imdbws.com/title.ratings.tsv.gz",ratingsFile+".gz").then(()=>gunzip(ratingsFile+".gz",ratingsFile));
  if(!fs.existsSync(basicsFile)) await download("https://datasets.imdbws.com/title.basics.tsv.gz",basicsFile+".gz").then(()=>gunzip(basicsFile+".gz",basicsFile));
}
async function imdbChart(kind,limit){
  const key=`imdb:${kind}:${limit}`; const c=getCache(key); if(c)return c; await ensureImdbFiles();
  const wanted=kind==="movie"?"movie":"tvSeries,tvMiniSeries"; const basics=new Map();
  const bs=fs.readFileSync(basicsFile,"utf8").split("\n");
  for(let i=1;i<bs.length;i++){const p=bs[i].split("\t");if(p.length<9||!p[1])continue;if(wanted.split(",").includes(p[1]))basics.set(p[0],p);}
  const rs=fs.readFileSync(ratingsFile,"utf8").split("\n"); const arr=[];
  for(let i=1;i<rs.length;i++){const p=rs[i].split("\t");if(p.length<3)continue;const b=basics.get(p[0]);if(!b)continue;const votes=Number(p[2]);if(votes<10000)continue;arr.push({id:p[0],rating:Number(p[1]),votes});}
  arr.sort((a,b)=>b.rating-a.rating||b.votes-a.votes);
  const ids=arr.slice(0,limit).map(x=>x.id);
  const found=await parallelMap(ids,async id=>{const d=await tmdb(`/find/${id}`,{external_source:"imdb_id",language:"fr-FR"});return (kind==="movie"?d.movie_results:d.tv_results)?.[0];},10);
  return setCache(key,found);
}

async function trakt(pathname){
  if(!TRAKT_ID||!TRAKT_TOKEN)throw new Error("TRAKT_CLIENT_ID/TRAKT_ACCESS_TOKEN not configured");
  return jsonFetch(`https://api.trakt.tv${pathname}`,{headers:{"trakt-api-key":TRAKT_ID,"trakt-api-version":"2","Authorization":`Bearer ${TRAKT_TOKEN}`}});
}
async function history(type){
  const key=`history:${type}`; const c=getCache(key); if(c)return c; if(!TRAKT_USER)throw new Error("TRAKT_USERNAME not configured");
  const d=await trakt(`/users/${encodeURIComponent(TRAKT_USER)}/history/${type}?limit=100`);
  const raw=d.map(x=>x.movie||x.show).filter(Boolean);
  const out=await parallelMap(raw,async x=>{const tmdbId=x.ids?.tmdb; return tmdbId?{id:tmdbId,title:x.title,name:x.name}:null;},12);
  return setCache(key,out);
}
async function traktRecommendations(type){
  const key=`traktrec:${type}`; const c=getCache(key); if(c)return c; if(!TRAKT_TOKEN)throw new Error("Trakt not configured");
  const d=await trakt(type==="movie"?"/recommendations/movies?limit=100":"/recommendations/shows?limit=100");
  const out=d.map(x=>type==="movie"?x.movie:x.show).filter(Boolean).map(x=>x.ids?.tmdb?{id:x.ids.tmdb,title:x.title,name:x.title}:null).filter(Boolean);
  return setCache(key,out);
}
async function aiRecommendations(type){
  const key=`airec:${type}`; const c=getCache(key); if(c)return c;
  if(!AI_KEY)return traktRecommendations(type);
  const h=await history(type==="movie"?"movies":"shows"); const names=h.slice(0,60).map(x=>x.title||x.name);
  const prompt=`Recommend 100 ${type==="movie"?"films":"series"} based on this viewing history. Return ONLY a JSON array of titles, no markdown. History: ${JSON.stringify(names)}`;
  const r=await fetch(`${AI_BASE}/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${AI_KEY}`},body:JSON.stringify({model:AI_MODEL,messages:[{role:"user",content:prompt}],temperature:.4})});
  if(!r.ok)throw new Error(`AI ${r.status}`); const j=await r.json(); const text=(j.choices?.[0]?.message?.content||"[]").replace(/```json|```/g,"").trim();
  let titles=[]; try{titles=JSON.parse(text);}catch{return traktRecommendations(type);} const out=[];
  for(const title of titles.slice(0,100)){try{const d=await tmdb(`/search/${type}`,{query:title,language:"fr-FR",page:1});if(d.results?.[0])out.push(d.results[0]);}catch{}}
  return setCache(key,uniq(out));
}

async function source(id,type){
  if(id==="fr_top20_today")return top20(type);
  if(id==="fr_streaming_releases"&&type==="movie")return franceMovieReleases();
  if(id==="fr_series_releases"&&type==="series")return franceSeriesReleases();
  if(id==="imdb_top100_movies"&&type==="movie")return imdbChart("movie",100);
  if(id==="imdb_top100_series"&&type==="series")return imdbChart("series",100);
  if(id==="imdb_top250_movies"&&type==="movie")return imdbChart("movie",250);
  if(id==="imdb_top250_series"&&type==="series")return imdbChart("series",250);
  if(id==="history_movies"&&type==="movie")return history("movies").then(x=>x);
  if(id==="history_series"&&type==="series")return history("shows").then(x=>x);
  if(id==="ai_recommendations_movies"&&type==="movie")return aiRecommendations("movie");
  if(id==="ai_recommendations_series"&&type==="series")return aiRecommendations("series");
  throw new Error("Unknown catalog");
}
function parseRequest(req){
  const m=req.path.match(/^\/catalog\/(movie|series)\/([^/]+)(?:\/(.*))?\.json$/); if(!m)return null;
  const extra={}; if(m[3])for(const part of m[3].split("&")){const [k,v]=part.split("=");if(k)extra[decodeURIComponent(k)]=decodeURIComponent(v||"");}
  return {type:m[1],id:m[2],skip:Math.max(0,Number(extra.skip||0)||0)};
}
function sendJson(res, status, obj, cache=false){
  const body=JSON.stringify(obj);
  res.statusCode=status;
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin","*");
  if(cache) res.setHeader("Cache-Control","public, max-age=10800, stale-while-revalidate=3600");
  res.end(body);
}
function routeCatalog(urlPath){
  const m=urlPath.match(/^\/catalog\/(movie|series)\/([^/]+)(?:\/(.*))?\.json$/);
  if(!m)return null;
  const extra={}; if(m[3])for(const part of m[3].split("&")){if(!part)continue;const [k,v]=part.split("=");extra[decodeURIComponent(k)]=decodeURIComponent(v||"");}
  return {type:m[1],id:m[2],skip:Math.max(0,Number(extra.skip||0)||0)};
}
const server=http.createServer(async (req,res)=>{
  try{
    const u=new URL(req.url,`http://${req.headers.host||"localhost"}`);
    if(u.pathname==="/manifest.json") return sendJson(res,200,JSON.parse(fs.readFileSync(path.join(__dirname,"manifest.json"),"utf8")));
    if(u.pathname==="/"){res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");return res.end("<h1>Nuvio France Catalogs — Dynamic v3</h1><p>12 catalogues • cache 3h • TMDB + Posters+</p>");}
    const r=routeCatalog(u.pathname); if(r){
      const all=await source(r.id,r.type); const slice=all.slice(r.skip,r.skip+PAGE_SIZE);
      const metas=await parallelMap(slice,(x,i)=>toMeta(x,r.type,r.skip+i+1),6);
      return sendJson(res,200,{metas},true);
    }
    sendJson(res,404,{error:"Not found"});
  }catch(e){sendJson(res,200,{metas:[],error:e.message});}
});
server.listen(PORT,()=>console.log(`Nuvio addon listening on ${PORT}; catalog cache ${CACHE_MS/3600000}h`));
