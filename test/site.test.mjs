// site.mjs の絞り込みが、公開してはいけないものを落としているか
import assert from 'node:assert/strict';
import { publicData } from '../site.mjs';

const data = {
  events: [
    { id: 'a', date: '2026-10-01', title: '公開', djs: ['dj1'], vjs: [{ id: 'vj1' }], flyer: 'images/a.jpg' },
    { id: 'b', date: '2026-11-01', title: 'まだ内緒', comingSoon: true, djs: ['secret'], flyer: 'images/b.jpg', links: [{ label: 'x', url: 'https://x' }] },
    { id: 'c', date: '2026-12-01', title: '下書き', draft: true, djs: ['draftdj'] },
  ],
  tags: [],
  people: { dj1: {}, vj1: {}, secret: {}, draftdj: {}, unused: {}, aym_pngn: {} },
  watchAccounts: ['x'],
};
const pub = publicData(data);

assert.deepEqual(pub.events.map((e) => e.id), ['a', 'b'], 'draft は出さない');
const cs = pub.events.find((e) => e.id === 'b');
assert.deepEqual(cs.djs, []);
assert.equal(cs.flyer, undefined);
assert.equal(cs.links, undefined);
assert.equal(cs.title, 'まだ内緒', 'COMING SOON でもタイトルは出す');
assert.deepEqual(Object.keys(pub.people).sort(), ['aym_pngn', 'dj1', 'vj1'], '使われていない人・内緒の人は出さない');
assert.equal(pub.watchAccounts, undefined);
assert.equal(pub.events.find((e) => e.id === 'a').draft, undefined);
console.log('site: ok');
