import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './input.mjs';
const scrypt = promisify(derive);
const digest = value => createHash('sha256').update(value).digest('hex');
const cookieName = 'sixi_session';
const publicUser = row => row ? { id: row.id, username: row.username, role: row.role } : null;
function credentials(input) {
 if(typeof input.username!=='string'||! /^[\p{L}\p{N}_.@-]{3,80}$/u.test(input.username.trim()))throw new AppError('用户名需为 3–80 位字母、数字、中文或 _.@-');
 if(typeof input.password!=='string'||input.password.length<10||input.password.length>128)throw new AppError('密码需为 10–128 位');
 return { username:input.username.trim(),password:input.password };
}
export class Authentication {
 constructor(store,{enabled=false,dataDir,secureCookie=false}={}) {
  this.store=store;this.enabled=enabled;this.secureCookie=secureCookie;this.attempts=new Map();
  store.db.exec(`CREATE TABLE IF NOT EXISTS team_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','analyst')),created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS team_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES team_users(id),expires_at INTEGER NOT NULL);`);
  if(enabled){
   const tokenPath=join(dataDir,'local-client-token');
   try{this.clientToken=readFileSync(tokenPath,'utf8').trim();}catch(error){if(error.code!=='ENOENT')throw error;this.clientToken=randomBytes(32).toString('hex');writeFileSync(tokenPath,this.clientToken,{mode:0o600,flag:'wx'});}
   chmodSync(tokenPath,0o600);
  }
 }
 users(){return this.store.db.prepare('SELECT id,username,role FROM team_users ORDER BY created_at').all();}
 count(){return this.store.db.prepare('SELECT COUNT(*) AS n FROM team_users').get().n;}
 identity(req){
  if(!this.enabled)return {id:'local',username:'本机工作空间',role:'admin',local:true};
  const bearer=/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1];
  if(bearer&&timingSafeEqual(Buffer.from(digest(bearer)),Buffer.from(digest(this.clientToken))))return {id:'local-client',username:'本机工具',role:'admin',local:true};
  const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
  const row=this.store.db.prepare('SELECT u.id,u.username,u.role FROM team_sessions s JOIN team_users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>?').get(digest(token),Date.now());
  return publicUser(row);
 }
 require(req,{admin=false}={}){
  const user=this.identity(req);if(!user)throw new AppError('登录已失效，请重新登录。后台采集仍会继续。',401,'AUTHENTICATION_REQUIRED');
  if(admin&&user.role!=='admin')throw new AppError('此操作仅管理员可用',403,'ADMIN_REQUIRED');return user;
 }
 async add(input,{setup=false}={}){
  const {username,password}=credentials(input);const role=setup?'admin':input.role||'analyst';
  if(!['admin','analyst'].includes(role))throw new AppError('账号角色无效');
  const salt=randomBytes(16).toString('hex');const passwordHash=(await scrypt(password,salt,64)).toString('hex');
  return this.store.transaction(()=>{
   if(setup&&this.count())throw new AppError('管理员已设置，请登录',409);
   if(this.store.db.prepare('SELECT id FROM team_users WHERE username=?').get(username))throw new AppError('用户名已存在',409);
   const id=randomUUID();this.store.db.prepare('INSERT INTO team_users VALUES (?,?,?,?,?,?)').run(id,username,passwordHash,salt,role,new Date().toISOString());
   return {id,username,role};
  });
 }
 setSession(res,userId){
  const token=randomBytes(32).toString('hex'),expires=Date.now()+12*60*60*1000;
  this.store.db.prepare('DELETE FROM team_sessions WHERE expires_at<=?').run(Date.now());
  this.store.db.prepare('INSERT INTO team_sessions VALUES (?,?,?)').run(digest(token),userId,expires);
  res.setHeader('Set-Cookie',`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${this.secureCookie?'; Secure':''}`);
 }
 async login(input,req,res){
  const username=typeof input.username==='string'?input.username.trim():'';
  const key=digest(`${req.socket.remoteAddress}:${username.slice(0,80)}`);
  const now=Date.now();for(const [k,v]of this.attempts)if(v.until<=now)this.attempts.delete(k);
  if(this.attempts.size>1000)this.attempts.clear();
  const attempt=this.attempts.get(key)||{count:0,until:now+15*60*1000};
  if(attempt.count>=8)throw new AppError('登录尝试过多，请 15 分钟后重试',429,'RATE_LIMITED');
  attempt.count++;this.attempts.set(key,attempt);
  if(typeof input.password!=='string'||input.password.length>128)throw new AppError('用户名或密码不正确',401,'LOGIN_FAILED');
  const user=this.store.db.prepare('SELECT * FROM team_users WHERE username=?').get(username);
  const candidate=await scrypt(input.password,user?.salt||'invalid-user-salt',64);
  if(!user||!timingSafeEqual(candidate,Buffer.from(user.password_hash,'hex')))throw new AppError('用户名或密码不正确',401,'LOGIN_FAILED');
  this.attempts.delete(key);this.setSession(res,user.id);return publicUser(user);
 }
 logout(req,res){
  const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  if(token)this.store.db.prepare('DELETE FROM team_sessions WHERE token_hash=?').run(digest(token));
  res.setHeader('Set-Cookie',`${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.secureCookie?'; Secure':''}`);
 }
}
export async function authenticationRoute(req,url,{auth,res,body,json}){
 const path=url.pathname;if(!path.startsWith('/api/auth/'))return false;
 if(path==='/api/auth/status'&&req.method==='GET')json(res,200,{ok:true,enabled:auth.enabled,needsSetup:auth.enabled&&auth.count()===0,user:auth.identity(req)});
 else if(path==='/api/auth/setup'&&req.method==='POST'){
  if(!auth.enabled)throw new AppError('当前使用本机免登录模式',400);
  const user=await auth.add(await body(req),{setup:true});auth.setSession(res,user.id);json(res,201,{ok:true,user});
 }else if(path==='/api/auth/login'&&req.method==='POST')json(res,200,{ok:true,user:await auth.login(await body(req),req,res)});
 else if(path==='/api/auth/logout'&&req.method==='POST'){auth.logout(req,res);json(res,200,{ok:true});}
 else if(path==='/api/auth/users'){
  auth.require(req,{admin:true});
  if(req.method==='GET')json(res,200,{ok:true,items:auth.users()});
  else if(req.method==='POST')json(res,201,{ok:true,user:await auth.add(await body(req))});
  else throw new AppError('不支持此操作',405);
 }else throw new AppError('登录接口不存在',404);
 return true;
}
