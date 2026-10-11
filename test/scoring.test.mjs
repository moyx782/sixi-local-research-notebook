import test from 'node:test';
import assert from 'node:assert/strict';
import {marketAssessment,marketCriteria} from '../backend/scoring.mjs';

test('market scoring requires citation and rationale per criterion, uses explicit weights, and withholds incomplete totals',()=>{
 assert.equal(Object.values(marketCriteria).reduce((sum,c)=>sum+c.weight,0),100);
 assert.equal(marketAssessment().score,null);
 const record=score=>({score,basis:'Bounded inference from source',evidenceIds:['e1']});
 const partial=marketAssessment({demand:record(5)},['e1']);assert.equal(partial.coverage,1);assert.equal(partial.score,null);
 const complete=marketAssessment({demand:record(5),growth:record(4),competition:record(3),access:record(2),fit:record(1)},['e1']);
 assert.equal(complete.score,63);
 assert.throws(()=>marketAssessment({demand:record(6)},['e1']),/1–5/);
 assert.throws(()=>marketAssessment({demand:{...record(3),basis:''}},['e1']),/评分依据/);
 assert.throws(()=>marketAssessment({demand:record(3)},[]),/Evidence/);
 assert.throws(()=>marketAssessment({invented:record(3)},['e1']),/维度无效/);
});
