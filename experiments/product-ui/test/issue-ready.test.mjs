import {test} from 'node:test';
import assert from 'node:assert/strict';
import {issueBodyReady} from '../e2e/issue-ready.mjs';
const id='00000000-0000-4000-8000-000000000001';
test('old create form is not treated as ready issue body despite its identical textarea label',()=>{
  assert.equal(issueBodyReady({href:'https://fixture.invalid/?view=create&projectId='+id,editorMode:'create'}),false);
  assert.equal(issueBodyReady({href:'https://fixture.invalid/?view=issue&issueId='+id,editorMode:'create'}),false);
  assert.equal(issueBodyReady({href:'https://fixture.invalid/?view=create&projectId='+id,editorMode:'body'}),false);
});
test('both current issue route and unlocked issue-body editor are required',()=>{
  const href='https://fixture.invalid/?view=issue&issueId='+id;
  assert.equal(issueBodyReady({href,editorMode:'body'}),true);
  for(const editorMode of ['','title','create',null])assert.equal(issueBodyReady({href,editorMode}),false);
  assert.equal(issueBodyReady({href:'https://fixture.invalid/?view=issue&issueId=invalid',editorMode:'body'}),false);
  assert.equal(issueBodyReady({href:href+'&projectId='+id,editorMode:'body'}),false);
});
