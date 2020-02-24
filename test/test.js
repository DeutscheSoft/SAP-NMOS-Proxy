import test from 'ava';
import { Log, SDP, DynamicSet } from '../index.js';

// do not want to see errors.
Log.level = -1;

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
test('DynamicSet.filter with errors', t => {
    const a = enumerate(10);
    const is_even = (v) => {
      if (!(v & 1)) return true;
      throw new Error('Ignore me.');
    };
    t.deepEqual(a.filter((v) => !(v & 1)), Array.from(DynamicSet.from(a).filter(is_even).keys()));
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

test('DynamicSet.asyncFilter error', async t => {
    const a = enumerate(10);
    const is_even = async (v) => {
      await random_sleep(v);
      if (v & 1) throw new Error('foo');
      return true;
    };
    const is_odd = async (v) => {
      await random_sleep(v);
      if (!(v & 1)) throw new Error('foo');
      return true;
    };

    const even = DynamicSet.from(a).asyncFilter(is_even);
    const odd = DynamicSet.from(a).asyncFilter(is_odd);

    await sleep(100);

    await even.wait();
    await odd.wait();

    t.deepEqual(Array.from(even.union(odd).keys()).sort(), a.sort());
});

test('DynamicSet.asyncMap', async t => {
    const a = enumerate(10);

    const set = DynamicSet.from(a).asyncMap(async (id, v) => {
      await random_sleep(v);
      return [ id * 2, v * 2 ]
    });

    await sleep(100);

    await set.wait();

    t.deepEqual(Array.from(set.values()).sort(), a.map((v) => v*2).sort());
});

test('SDP', t => {
    const sdp = new SDP([ "v=0\r\n",
    "o=- 29054176 %d IN IP4 192.168.178.134\r\n",
    "s=Y001-Yamaha-Ri8-D-14e622 : 32\r\n",
    "c=IN IP4 239.69.205.203/32\r\n",
    "t=0 0\r\n",
    "a=keywds:Dante\r\n",
    "m=audio 5004 RTP/AVP 96\r\n",
    "i=1 channels: 02\r\n",
    "a=recvonly\r\n",
    "a=rtpmap:96 L24/48000/1\r\n",
    "a=ptime:1\r\n",
    "a=ts-refclk:ptp=IEEE1588-2008:00-1D-C1-FF-FE-14-E6-22:0\r\n",
    "a=mediaclk:direct=750129611" ].join(""));

    const clock = {
      type: 'ptp',
      version: 'IEEE1588-2008',
      gmid: '00-1D-C1-FF-FE-14-E6-22',
      domain: '0',
      traceable: false,
    };
    t.deepEqual(sdp.ptp_clock, clock);
});
