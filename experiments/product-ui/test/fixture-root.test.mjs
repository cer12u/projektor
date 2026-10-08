import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {enterFixtureRoot} from '../e2e/fixture-root.mjs';
test('fixture root stays selected across async setup and restores idempotently after cleanup',async()=>{
  const previous=process.cwd(),asset=resolve('dist-fixture/fixture.html'),root=mkdtempSync(join(tmpdir(),'projektor-fixture-root-'));
  try{
    const restore=enterFixtureRoot(root);await Promise.resolve();assert.equal(process.cwd(),root);
    assert.equal(asset,resolve(previous,'dist-fixture/fixture.html'));
    restore();restore();assert.equal(process.cwd(),previous);
  }finally{process.chdir(previous);rmSync(root,{recursive:true,force:true});}
});
test('failed fixture body can restore the original cwd without a fallback environment',()=>{
  const previous=process.cwd(),root=mkdtempSync(join(tmpdir(),'projektor-fixture-root-'));
  try{
    assert.throws(()=>{const restore=enterFixtureRoot(root);try{throw Error('synthetic failure');}finally{restore();}},/synthetic/);
    assert.equal(process.cwd(),previous);
  }finally{process.chdir(previous);rmSync(root,{recursive:true,force:true});}
});
