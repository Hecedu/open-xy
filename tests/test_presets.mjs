import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildAssets, presetPath, sha256} from '../builder/core.mjs';
import {Device} from '../builder/mtp.mjs';
import {fakeDevice} from './fixtures/mtp.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// Catalog entries as the Python SDK writes them (any valid Q15 defaults).
const entry = (id, params) => ',\n        ' + JSON.stringify({type:id, default_params:params});
const machines = ['fm2op', 'macroosc', 'timestretch'].map((id, i) => {
  const machine = JSON.parse(read(`machines/${id}/machine.json`));
  return {id, kind: machine.kind, catalog: entry(id, [i, 1000 * i, 32767, 0, 0, 0, 0, 0]),
    presetDefaults: machine.presetDefaults ?? {}};
});
machines.push({id:'ringmod', kind:'effect',
  catalog:entry('ringmod', [0, 32767, 0, 0, 0, 0, 0, 0]).replace('"type":"ringmod"', '"type":"ringmod","id":1')});
// The numbers a layout gave: the effect's menu entry carries its own.
const numbers = {ringmod: {effect: 6, page: 21}};

async function fixture(selectedMachines = machines) {
  // Authored menu fixture with its own insertion points; no captured firmware or factory content.
  const text = '{"engine_types":[{"type":"existing"}\n    ],"fx_types":[{"type":"existing-fx"}\n    ]}';
  const catalog = new TextEncoder().encode(text);
  const stock_catalog_inserts = {engine_types: text.indexOf('\n    ]'), fx_types: text.lastIndexOf('\n    ]')};
  return {kit: {machines:selectedMachines, profile:{stock_catalog_sha256:await sha256(catalog), stock_catalog_inserts}}, catalog};
}

test('all selections include only their instrument presets with native names and definition defaults', async () => {
  const {kit,catalog} = await fixture(), original = structuredClone(machines);
  for (let mask=1; mask<16; mask++) {
    const selected=machines.filter((_,i)=>mask & 2**i);
    const files=await buildAssets(kit,selected.map(m=>m.id),catalog,numbers);
    assert.deepEqual(Object.keys(files).sort(),['content/op1_factory.json',
      ...selected.filter(m=>m.kind!=='effect').map(m=>`content/presets/${m.id}/default.json`)].sort());
    for(const m of selected.filter(m=>m.kind!=='effect')) {
      const p=JSON.parse(new TextDecoder().decode(files[presetPath(m)]));
      assert.equal(p.type,{'fm2op':'fm2op','macroosc':'macroosc',timestretch:'timestretch'}[m.id]);
      assert.equal(p.version,4); assert.equal(p.platform,'OP-XY');
      assert.deepEqual(p.engine.params,JSON.parse(m.catalog.slice(1)).default_params);
      assert.equal(p.engine.playmode,'poly');
      assert.deepEqual(p.regions,[]); // A preset never points into a user's sample library.
      assert.equal(p.fx.active,false); assert.equal(p.lfo.active,false);
      assert.ok(p.engine.volume>0 && p.engine.volume<=32767);
      assert.ok(p.envelope.amp.sustain>0);
      assert.equal(p.envelope.amp.release,32767); // Device-saved minimum release.
      for (const [key, value] of Object.entries(m.presetDefaults.amp ?? {})) assert.equal(p.envelope.amp[key], value);
      assert.equal(p.mtime,undefined);
    }
    const menu=JSON.parse(new TextDecoder().decode(files['content/op1_factory.json']));
    assert.deepEqual(menu.engine_types[0],{type:'existing'});
    if (selected.some(m=>m.id==='ringmod')) assert.equal(menu.fx_types.at(-1).id,6);
    assert.deepEqual(Object.keys(files).filter(p=>p.startsWith('user/')),[]);
  }
  assert.deepEqual(machines,original);
});

test('preset generation rejects unsafe paths, foreign kinds and invalid engine parameter values', async () => {
  for(const id of ['../fm2op','two/op','two\\op','']) assert.throws(()=>presetPath({id,kind:'synth'}));
  assert.throws(()=>presetPath({id:'example',kind:'unknown'}));
  for(const params of [[0],Array(8).fill(-1),Array(8).fill(32768),Array(8).fill(.5),Array(8).fill(null)]) {
    const m={id:'example',kind:'synth',catalog:', '+JSON.stringify({type:'example',default_params:params})};
    const {kit,catalog}=await fixture([m]);
    await assert.rejects(buildAssets(kit,['example'],catalog,numbers),/preset engine or defaults/);
  }
  const {kit,catalog}=await fixture([{id:'example',kind:'synth',catalog:',{"type":"../bad","default_params":[0,0,0,0,0,0,0,0]}'}]);
  await assert.rejects(buildAssets(kit,['example'],catalog,numbers),/preset engine or defaults/);
});

test('catalog defaults are required and reach nested MTP content folders unchanged', async () => {
  const m = {...machines[0], origin:'catalog'};
  const {kit,catalog} = await fixture([m]);
  await assert.rejects(buildAssets(kit,[m.id],catalog,numbers), /missing presets\/default.json/);
  m.defaultPreset = JSON.parse(read('machines/fm2op/presets/default.json'));
  m.defaultPreset.engine.params[0] = 7312;
  m.defaultPreset.envelope.amp.attack = 987;
  const original = structuredClone(m.defaultPreset);
  const files = await buildAssets(kit,[m.id],catalog,numbers);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files[presetPath(m)])), original);
  const userPath = 'presets/my-sound.json', user = Uint8Array.of(7);
  const {device,state} = fakeDevice({files: {[userPath]: user}}), mtp = new Device(device);
  await mtp.open();
  for (const [path, bytes] of Object.entries(files)) await mtp.send(path,bytes);
  await mtp.close();
  assert.deepEqual(state.read(presetPath(m)), files[presetPath(m)]);
  assert.deepEqual(state.read(userPath),user);
  assert.deepEqual(m.defaultPreset,original);
});
