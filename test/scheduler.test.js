import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, validateIssues } from '../src/scheduler.js';
const issue = (number, state='ready', model='terra', dependencies=[], paths=[]) => ({number,title:`Issue ${number}`,state,model,dependencies,paths});
test('schedules independent issues on matching workers', () => {
  const result = plan([issue(1,'done'), issue(2,'ready','terra',[1],['a']), issue(3,'ready','sol',[1],['b'])]);
  assert.deepEqual(result.assignments.map(x=>x.issue),[2,3]);
});
test('never dispatches blocked dependencies', () => {
  const result = plan([issue(1,'blocked'), issue(2,'ready','terra',[1])]);
  assert.equal(result.assignments.length,0);
  assert.equal(result.waiting[0].reason,'dependency');
});
test('avoids reserved paths', () => {
  const result = plan([issue(1,'ready','terra',[],['apps/editor']),issue(2,'ready','terra',[],['apps/editor'])]);
  assert.equal(result.assignments.length,1);
});
test('does not reuse occupied worker', () => {
  const result = plan([issue(1)],undefined,[{worker:'terra-a',issue:9}]);
  assert.equal(result.assignments[0].worker,'terra-b');
});
test('rejects missing dependencies and cycles', () => {
  assert.throws(()=>validateIssues([issue(1,'ready','terra',[2])]),/Missing dependency/);
  assert.throws(()=>validateIssues([issue(1,'ready','terra',[2]),issue(2,'ready','terra',[1])]),/cycle/);
});
test('does not mutate issue input', () => {
  const items=[issue(1)]; const before=JSON.stringify(items); plan(items); assert.equal(JSON.stringify(items),before);
});
