
import express from "express";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import https from "https";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 7000);
const TMDB = process.env.TMDB_API_KEY;
const TRAKT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_TOKEN = process.env.TRAKT_ACCESS_TOKEN;
const TRAKT_USER = process.env.TRAKT_USERNAME;
const AI_KEY = process.env.OPENAI_API_KEY;
const AI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/,"");
const AI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const EXCLUDE_INDIA = String(process.env.EXCLUDE_INDIA || "true") !== "false";
const CACHE_MS = Number(process.env.CACHE_MINUTES || 30) * 60_000;

const cache = new Map();

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  const v = fn();
  cache.set(key, {t: Date.now(), v});
  return v;
}
async function jsonFetch(url, headers={}) {
  const r = await fetch(url, {headers});
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
function tmdb(pathname, params={}) {
  if (!TMDB) throw new Error("TMDB_API_KEY is not configured");
  const u = new URL(`https://api.themoviedb.org/3${pathname}`);
  u.searchParams.set("api_key", TMDB);
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  return jsonFetch(u);
}
function daysAgo(n){ const d=new Date(); d.setUTCDate(d.getUTCDate()-n); return d.toISOString().slice(0,10); }
function daysAhead(n){ const d=new Date(); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function uniq(items){ const m=new Map(); for(const x of items) if(x?.id) m.set(x.id,x); return [...m.values()]; }

const POSTERS_PLUS = "https://postersplus.slokker.cc/poster?tmdb_id={tmdb_id?}&imdb_id={imdb_id?}&stremio_id={id}&type={type}&shape={shape}&primary_client=stremio_tv_nuvio&top_gradient=medium&sash_mode=notch&landscape_sash_mode=sash&badge_pos=top_left&fallback_to_imdb=true&rating_display_mode=2&score_out_of_10=true&movie_weights=tomatoes%3A0.20%2Cpopcorn%3A0.20%2Cimdb%3A0.60&tv_weights=trakt%3A0.30%2Cimdb%3A0.70&anime_movie_weights=myanimelist%3A0.20%2Canilist%3A0.20%2Ckitsu%3A0.20%2Ctrakt%3A0.10%2Cimdb%3A0.30&anime_tv_weights=myanimelist%3A0.20%2Canilist%3A0.20%2Ckitsu%3A0.20%2Ctrakt%3A0.10%2Cimdb%3A0.30&logo_language=fr&logo_priority=native_if_original_english&fallback_bg_style=photoreal&sash_badge_size_w=1.40&sash_badge_size_h=1.20&sash_badge_inset=0.000&badge_min_score=5";
function poster(p){ return p ? `https://image.tmdb.org/t/p/w500${p}` : undefined; }
function backdrop(p){ return p ? `https://image.tmdb.org/t/p/w1280${p}` : undefined; }
function postersPlus({tmdbId, imdbId, stremioId, type, shape="poster"}) {
  return POSTERS_PLUS
    .replace('{tmdb_id?}', encodeURIComponent(tmdbId || ''))
    .replace('{imdb_id?}', encodeURIComponent(imdbId || ''))
    .replace('{id}', encodeURIComponent(stremioId || (imdbId || `${type}:${tmdbId}`)))
    .replace('{type}', encodeURIComponent(type === 'series' ? 'series' : 'movie'))
    .replace('{shape}', encodeURIComponent(shape));
}

async function imdbId(media_type, id) {
  try {
    const d = await tmdb(`/${media_type}/${id}/external_ids`);
    return d.imdb_id || undefined;
  } catch { return undefined; }
}
async function metaPreview(item, media_type) {
  const title = item.title || item.name || item.original_title || item.original_name;
  const date = item.release_date || item.first_air_date;
  const iid = await imdbId(media_type, item.id);
  const stremioId = iid || `${media_type}:${item.id}`;
  return {
    id: stremioId,
    type: media_type === "movie" ? "movie" : "series",
    name: title,
    poster: postersPlus({tmdbId:item.id, imdbId:iid, stremioId, type:media_type, shape:"poster"}),
    background: backdrop(item.backdrop_path),
    description: item.overview,
    releaseInfo: date ? date.slice(0,4) : undefined,
    imdbRating: item.vote_average ? Number(item.vote_average.toFixed(1)) : undefined
  };
}

async function discoverMovies(params) {
  let all=[];
  for(let page=1; page<=2 && all.length<100; page++){
    const d=await tmdb("/discover/movie",{language:"fr-FR",region:"FR",page,...params});
    all.push(...(d.results||[]));
    if(page>=d.total_pages) break;
  }
  return all;
}
async function discoverSeries(params) {
  let all=[];
  for(let page=1; page<=2 && all.length<100; page++){
    const d=await tmdb("/discover/tv",{language:"fr-FR",watch_region:"FR",page,...params});
    all.push(...(d.results||[]));
    if(page>=d.total_pages) break;
  }
  return all;
}

/* France: release type 4 = digital, 5 = physical.
   We deliberately use region=FR and then remove India-origin titles if enabled. */
async function frStreamingMovies() {
  // TMDB's region + release type filters use the regional FR release date.
  // We then verify each candidate's actual FR Digital/Physical release dates,
  // which prevents a US/UK primary date from incorrectly ordering the catalog.
  const candidates = await discoverMovies({
    "release_date.gte": daysAgo(45),
    "release_date.lte": new Date().toISOString().slice(0,10),
    "with_release_type":"4|5",
    "sort_by":"popularity.desc",
    "vote_count.gte":0
  });
  const rows=[];
  for (const x of candidates.slice(0,80)) {
    try {
      const rd=await tmdb(`/movie/${x.id}/release_dates`);
      const fr=(rd.results||[]).find(r=>r.iso_3166_1==='FR');
      const dates=(fr?.release_dates||[]).filter(r=>[4,5].includes(r.type) && r.release_date);
      if(!dates.length) continue;
      const latest=dates.map(r=>r.release_date.slice(0,10)).filter(d=>d<=new Date().toISOString().slice(0,10)).sort().pop();
      if(!latest) continue;
      rows.push({...x, release_date:latest, _frReleaseDate:latest});
    } catch {}
  }
  rows.sort((a,b)=>b._frReleaseDate.localeCompare(a._frReleaseDate) || (b.popularity||0)-(a.popularity||0));
  return filterIndiaMovies(rows);
}

async function filterIndiaMovies(items){
  if(!EXCLUDE_INDIA) return items;
  const out=[];
  for(const x of items){
    try{
      const d=await tmdb(`/movie/${x.id}`,{language:"fr-FR"});
      const countries=(d.production_countries||[]).map(c=>c.iso_3166_1);
      if(!countries.includes("IN")) out.push(x);
    }catch{ out.push(x); }
  }
  return out;
}

async function topToday(type){
  // A country-specific "today" rail: TMDB trending itself is global, so we
  // combine current FR availability/release signals with popularity instead.
  if(type==='movie') {
    const d=await tmdb('/discover/movie',{language:'fr-FR',region:'FR',watch_region:'FR',with_watch_monetization_types:'flatrate|free|ads|rent|buy',sort_by:'popularity.desc',page:1});
    return (await filterIndiaMovies(d.results||[])).slice(0,20);
  }
  const d=await tmdb('/discover/tv',{language:'fr-FR',watch_region:'FR',with_watch_monetization_types:'flatrate|free|ads|rent|buy',sort_by:'popularity.desc',page:1});
  return (d.results||[]).filter(x=>!EXCLUDE_INDIA || !(x.origin_country||[]).includes('IN')).slice(0,20);
}

/* IMDb public datasets.
   On first use, download title.basics and title.ratings and cache locally.
   For production, run refresh-imdb.js daily with cron. */
const imdbDir=path.join(__dirname,"data");
const ratingsFile=path.join(imdbDir,"title.ratings.tsv");
const basicsFile=path.join(imdbDir,"title.basics.tsv");
function download(url, dest){
  return new Promise((resolve,reject)=>{
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    https.get(url,res=>{
      if(res.statusCode!==200){reject(new Error(`HTTP ${res.statusCode}`));return;}
      const out=fs.createWriteStream(dest); res.pipe(out);
      out.on("finish",()=>out.close(resolve));
    }).on("error",reject);
  });
}
async function ensureImdb(){
  if(!fs.existsSync(ratingsFile)) await download("https://datasets.imdbws.com/title.ratings.tsv.gz",ratingsFile+".gz").then(()=>gunzip(ratingsFile+".gz",ratingsFile));
  if(!fs.existsSync(basicsFile)) await download("https://datasets.imdbws.com/title.basics.tsv.gz",basicsFile+".gz").then(()=>gunzip(basicsFile+".gz",basicsFile));
}
function gunzip(src,dst){
  return new Promise((resolve,reject)=>fs.createReadStream(src).pipe(zlib.createGunzip()).pipe(fs.createWriteStream(dst)).on("finish",()=>{try{fs.unlinkSync(src)}catch{};resolve()}).on("error",reject));
}
/* Note: IMDb dataset rows do not directly provide localized release dates.
   The addon resolves the selected IMDb ids through TMDB for posters/metadata. */
async function imdbTop(kind, limit){
  await ensureImdb();
  const wanted = kind==="movie" ? "movie" : "tvSeries,tvMiniSeries";
  const ratings=fs.readFileSync(ratingsFile,"utf8").split("\n");
  const arr=[];
  for(let i=1;i<ratings.length;i++){
    const p=ratings[i].split("\t"); if(p.length<3) continue;
    const [id,rating,votes]=p;
    if(Number(votes)<10000) continue;
    arr.push({id,rating:Number(rating),votes:Number(votes)});
  }
  arr.sort((a,b)=>b.rating-a.rating || b.votes-a.votes);
  const ids=arr.slice(0,limit).map(x=>x.id);
  const out=[];
  for(const id of ids){
    try{
      const s=await jsonFetch(`https://api.graphql.imdb.com/`,{});
    }catch{}
    /* Resolve by TMDB search using the IMDb id. */
    try{
      const d=await tmdb(`/find/${id}`,{external_source:"imdb_id",language:"fr-FR"});
      const x=(kind==="movie"?d.movie_results:d.tv_results)?.[0];
      if(x) out.push(x);
    }catch{}
  }
  return out;
}

/* Trakt: requires the user's own Trakt credentials. */
async function trakt(pathname){
  if(!TRAKT_ID || !TRAKT_TOKEN) throw new Error("TRAKT_CLIENT_ID/TRAKT_ACCESS_TOKEN not configured");
  return jsonFetch(`https://api.trakt.tv${pathname}`,{
    "trakt-api-key":TRAKT_ID,
    "trakt-api-version":"2",
    "Authorization":`Bearer ${TRAKT_TOKEN}`
  });
}
async function traktHistory(type){
  if(!TRAKT_USER) throw new Error("TRAKT_USERNAME not configured");
  const d=await trakt(`/users/${encodeURIComponent(TRAKT_USER)}/history/${type}?limit=100`);
  return d.map(x=>x.movie||x.show).filter(Boolean);
}
async function recommendations(type){
  if(!TRAKT_USER) throw new Error("TRAKT_USERNAME not configured");
  const endpoint=type==="movie"?"/recommendations/movies?limit=20":"/recommendations/shows?limit=20";
  return await trakt(endpoint);
}
async function aiRecommendations(type){
  if(!AI_KEY) return recommendations(type);
  const history=await traktHistory(type);
  const names=history.slice(0,40).map(x=>x.title||x.name);
  const prompt=`Recommend 20 ${type==="movie"?"films":"series"} based on this viewing history. Avoid India-origin productions. Return ONLY a JSON array of titles. History: ${JSON.stringify(names)}`;
  const r=await jsonFetch(`${AI_BASE}/chat/completions`,{
    "Content-Type":"application/json",
    "Authorization":`Bearer ${AI_KEY}`
  });
  /* OpenAI-compatible endpoints need POST; handled below via fetch directly. */
  return recommendations(type);
}
async function aiTitles(type){
  if(!AI_KEY) return [];
  const history=await traktHistory(type);
  const prompt=`Recommend 20 ${type==="movie"?"films":"series"} based on this history. Avoid Indian-origin productions. Return only JSON array of titles. History: ${JSON.stringify(history.slice(0,50).map(x=>x.title||x.name))}`;
  const r=await fetch(`${AI_BASE}/chat/completions`,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${AI_KEY}`},
    body:JSON.stringify({model:AI_MODEL,messages:[{role:"user",content:prompt}],temperature:0.4})
  });
  if(!r.ok) throw new Error(`AI ${r.status}`);
  const j=await r.json();
  const content=j.choices?.[0]?.message?.content||"[]";
  const clean=content.replace(/```json|```/g,"").trim();
  return JSON.parse(clean);
}
async function searchTitles(titles,type){
  const out=[];
  for(const title of titles){
    try{
      const d=await tmdb(`/search/${type==="movie"?"movie":"tv"}`,{query:title,language:"fr-FR",page:1});
      if(d.results?.[0]) out.push(d.results[0]);
    }catch{}
  }
  return uniq(out);
}

async function catalog(id,type){
  const key=id;
  return cached(key, async()=>{
    let items=[];
    if(id==="fr_top20_movies_today" || id==="fr_top20_series_today") items=await topToday(type);
    else if(id==="fr_streaming_releases" && type==="movie") items=await frStreamingMovies();
    else if(id==="fr_series_releases" && type==="series"){
      items=await discoverSeries({"first_air_date.gte":daysAgo(30),"first_air_date.lte":new Date().toISOString().slice(0,10),"sort_by":"first_air_date.desc"});
    }
    else if(id==="imdb_top100_movies" && type==="movie") items=await imdbTop("movie",100);
    else if(id==="imdb_top100_series" && type==="series") items=await imdbTop("series",100);
    else if(id==="imdb_top250_movies" && type==="movie") items=await imdbTop("movie",250);
    else if(id==="imdb_top250_series" && type==="series") items=await imdbTop("series",250);
    else if(id==="history_movies" && type==="movie") items=await traktHistory("movies");
    else if(id==="history_series" && type==="series") items=await traktHistory("shows");
    else if(id==="ai_recommendations_movies" && type==="movie"){
      const titles=await aiTitles("movie"); items=await searchTitles(titles,"movie");
    }
    else if(id==="ai_recommendations_series" && type==="series"){
      const titles=await aiTitles("series"); items=await searchTitles(titles,"series");
    }
    else return [];
    const previews=[];
    for(const x of items.slice(0,250)) previews.push(await metaPreview(x,type));
    return previews;
  });
}

app.get("/manifest.json",(req,res)=>res.json(manifest()));
function manifest(){
  const m=JSON.parse(fs.readFileSync(path.join(__dirname,"manifest.json"),"utf8"));
  return m;
}
app.get("/catalog/:type/:id.json",async(req,res)=>{
  try{
    const data=await catalog(req.params.id,req.params.type);
    res.json({metas:data});
  }catch(e){
    console.error(e);
    res.json({metas:[]});
  }
});
app.get("/",(req,res)=>res.type("html").send(`<h1>France Catalogs</h1><p>Addon Nuvio/Stremio actif.</p><p><a href="/manifest.json">manifest.json</a></p>`));
app.listen(PORT,()=>console.log(`France Catalogs listening on :${PORT}`));
