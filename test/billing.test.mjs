import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateAnlas } from '../public/billing-estimate.js';

const draft = { model:'nai-diffusion-5-full', width:832, height:1216, steps:23, batch:1, mode:'generate' };
const opus = { connected:true, tier:3, entitled:true, usage:{ isNegative:false } };
const estimate = (settings={},account) => estimateAnlas({...draft,...settings},account);
const amount = (settings,account) => estimate(settings,account).max;

test('V5 estimator applies model effort, single Opus allowance, and the actual availability sign',()=>{
  assert.equal(amount({}),26);
  assert.equal(amount({medium:true}),15);
  assert.equal(amount({},opus),0);
  assert.equal(amount({batch:3},opus),52);
  assert.equal(amount({}, {...opus,usage:{percent:1,isNegative:true}}),26);
  const unknown=estimate({}, {...opus,usage:null});assert.deepEqual([unknown.min,unknown.max],[0,26]);
  assert.equal(amount({steps:29},opus),30);
});

test('reference surcharges distinguish per-sample precise from per-request Vibe and manual encoding',()=>{
  const base={model:'nai-diffusion-4-5-full',batch:2};
  assert.equal(amount({...base,references:[{kind:'style'},{kind:'character',enabled:false}]},opus),27);
  const quotes=estimate({...base,references:Array.from({length:6},()=>({kind:'vibe',encoded:false}))},opus);
  assert.equal(quotes.max,21);
  assert.ok(quotes.lines.some(line=>line.includes('12 Anlas')));
  assert.equal(estimateAnlas({mode:'encode-vibe',encoded:false}).max,2);
  assert.equal(estimateAnlas({mode:'encode-vibe',encoded:true}).max,0);
});

test('image operations use real source and work dimensions, Focus bounds and V3 sampler multipliers',()=>{
  const source={width:832,height:1216};
  assert.equal(amount({source,mode:'augment',tool:'bg-removal'},opus),65);
  assert.equal(amount({source,mode:'augment',tool:'lineart'},opus),0);
  assert.equal(amount({source:{width:1520,height:1000},mode:'upscale'}),2);
  assert.equal(amount({source,mode:'img2img',strength:.5}),13);
  assert.ok(amount({source,mode:'img2img',enhance:'max',strength:.7})>26);
  assert.equal(amount({source,mode:'inpaint',strength:.5,focusInpaint:true,focusUnknown:true}),null);
  assert.equal(amount({source,mode:'inpaint',strength:.5,focusInpaint:true,focusSize:{width:512,height:512}}),4);
  assert.equal(amount({model:'nai-diffusion-3',smea:'dynamic'}),24);
  assert.equal(amount({mode:'pixel-snap'}),0);
});
