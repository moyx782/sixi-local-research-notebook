import { AppError } from './input.mjs';
export const marketCriteria = {
 demand:{label:'客户需求强度',weight:25},growth:{label:'市场发展潜力',weight:20},competition:{label:'竞争环境有利度',weight:20},access:{label:'市场进入可行性',weight:15},fit:{label:'Domel 战略匹配度',weight:20},
};
export function marketAssessment(input={},evidenceIds=[]) {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('市场评分格式无效');
 if(Object.keys(input).some(key=>!marketCriteria[key]))throw new AppError('市场评分维度无效');
 const criteria={};
 for(const [key,value]of Object.entries(input)){
  const label=marketCriteria[key].label;
  if(!value||!Number.isInteger(value.score)||value.score<1||value.score>5)throw new AppError(`${label}需为 1–5 分`);
  if(typeof value.basis!=='string'||!value.basis.trim()||value.basis.length>1000)throw new AppError(`${label}需要评分依据（最多 1000 字）`);
  if(!Array.isArray(value.evidenceIds)||!value.evidenceIds.length||value.evidenceIds.some(id=>!evidenceIds.includes(id)))throw new AppError(`${label}必须引用该发现使用的 Evidence`);
  criteria[key]={score:value.score,basis:value.basis.trim(),evidenceIds:[...new Set(value.evidenceIds)]};
 }
 const coverage=Object.keys(criteria).length;
 const score=coverage===5?Math.round(Object.entries(criteria).reduce((sum,[key,value])=>sum+value.score/5*marketCriteria[key].weight,0)):null;
 return {version:'prototype-v1',criteria,coverage,score};
}
