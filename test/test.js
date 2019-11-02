import test from 'ava';
import { DynamicSet } from '../index.js';

function enumerate(n)
{
  const a = new Array(n);

  for (let i = 0; i < a.length; i++) a[i] = i;

  return a;
}

function sleep(n)
{
  return new Promise((resolve) => {
    setTimeout(resolve, n);
  });
}

function random_sleep(n)
{
  return sleep(1 + n * Math.random());
}
 
test('DynamicSet.from()', t => {
    t.deepEqual(enumerate(10), Array.from(DynamicSet.from(enumerate(10)).keys())); 
});
 
test('DynamicSet.filter', t => {
    const a = enumerate(10);
    const is_even = (v) => !(v & 1);
    t.deepEqual(a.filter(is_even), Array.from(DynamicSet.from(a).filter(is_even).keys())); 
});
test('DynamicSet.union', t => {
    const a = enumerate(10);
    const is_even = (v) => !(v & 1);
    const is_odd = (v) => !is_even(v);

    const even = DynamicSet.from(a).filter(is_even);
    const odd = DynamicSet.from(a).filter(is_odd);
    t.deepEqual(Array.from(even.union(odd).keys()).sort(), a.sort());
});
test('DynamicSet.map', t => {
    const a = enumerate(10);

    const set = DynamicSet.from(a).map((id, v) => [ id * 2, v * 2 ]);

    t.deepEqual(Array.from(set.keys()),
                a.map((v) => v*2));

    t.deepEqual(Array.from(set.values()),
                a.map((v) => v*2));
});

test('DynamicSet.asyncFilter simple', async t => {
    const a = enumerate(10);
    const is_true = async (v) => {
      await random_sleep(v);
      return true;
    };

    const set = DynamicSet.from(a).asyncFilter(is_true);

    await sleep(10);

    await set.wait();

    t.deepEqual(Array.from(set.keys()).sort(), a);
});

test('DynamicSet.asyncFilter', async t => {
    const a = enumerate(10);
    const is_even = async (v) => {
      await random_sleep(v);
      return !(v & 1);
    };
    const is_odd = async (v) => {
      await random_sleep(v);
      return !!(v & 1);
    };

    const even = DynamicSet.from(a).asyncFilter(is_even);
    const odd = DynamicSet.from(a).asyncFilter(is_odd);

    await sleep(100);

    await even.wait();
    await odd.wait();

    t.deepEqual(Array.from(even.union(odd).keys()).sort(), a.sort());
});
