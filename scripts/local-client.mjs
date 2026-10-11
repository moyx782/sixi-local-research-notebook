import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
// Credentials are only sent to explicitly chosen loopback services, never to source websites.
export async function localHeaders(base) {
 const url=new URL(base);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw new Error('本机凭据仅允许用于本机 HTTP 服务');
 if(!process.env.SIXI_DATA_DIR&&url.port!=='4173')return {};
 try {const token=(await readFile(join(process.env.SIXI_DATA_DIR||join(homedir(),'.sixi'),'local-client-token'),'utf8')).trim();return {authorization:`Bearer ${token}`};}
 catch(error){if(error.code==='ENOENT')return {};throw error;}
}
