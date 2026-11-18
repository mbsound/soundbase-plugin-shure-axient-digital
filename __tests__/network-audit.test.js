import test from 'node:test';
import assert from 'node:assert/strict';
import { probeAnx4 } from '../adapter.js';
import { FakeAd4q } from '../driver/fake/fake-ad4q.js';
import { rootParse, sdtMessages, SDT, parseWrapper, parseDmp } from '../driver/acn/pdu.js';

function captureRequests(fake) {
  const requests = [];
  const listener = (packet) => {
    const root = rootParse(packet);
    if (!root) return;
    for (const message of sdtMessages(root.sdt)) {
      if (message.vector !== SDT.REL_WRAP && message.vector !== SDT.UNREL_WRAP) continue;
      const wrapper = parseWrapper(message.data);
      for (const block of wrapper?.blocks ?? []) {
        if (block.proto === 2) requests.push(...parseDmp(block.payload));
      }
    }
  };
  fake.socket.on('message', listener);
  return requests;
}

for (const [firmware, expectStrings] of [['1.1.7.0', false], ['1.2.18.0', true]]) {
  test(`ANX4 discovery probe respects firmware ${firmware} before sending string keys`, async (t) => {
    const fake = new FakeAd4q({ model: 'ANX4', channels: 4, firmware });
    await fake.listen();
    t.after(() => fake.stop());
    const requests = captureRequests(fake);
    const result = await probeAnx4({ ip: '127.0.0.1', port: fake.controlPort, cid: fake.cid.toString('hex') });
    assert.equal(result.channels, 4);
    assert.equal(requests.some((request) => request.key !== undefined), expectStrings);
  });
}

test('a failed spectrum open closes its partially opened session', async (t) => {
  const { discoverDevices, getSimulator, shutdownDiscovery, createSpectrumAnalyzerAdapter, SIM_DEVICE_ID, PRODUCT } = await import('../adapter.js');
  const { SCAN_LIMITS } = await import('../driver/ad4q/scan.js');
  const previous = process.env.SB_AD4Q_NO_DISCOVERY;
  process.env.SB_AD4Q_NO_DISCOVERY = '1';
  t.after(async () => {
    if (previous === undefined) delete process.env.SB_AD4Q_NO_DISCOVERY;
    else process.env.SB_AD4Q_NO_DISCOVERY = previous;
    await shutdownDiscovery();
  });
  await discoverDevices({ simulate: true });
  const fake = getSimulator();
  fake.store.delete(SCAN_LIMITS.START);
  const adapter = createSpectrumAnalyzerAdapter({ id: SIM_DEVICE_ID, product: PRODUCT, config: { simulated: true } }, {});
  await assert.rejects(adapter.open(), /scan limits/);
  assert.equal(adapter.unit, null, 'failed open releases the session');
  assert.equal(adapter.closed, true);
});

test('a failed monitoring open closes its partially opened session', async (t) => {
  const { discoverDevices, shutdownDiscovery, createMonitoringAdapter, SIM_DEVICE_ID, PRODUCT } = await import('../adapter.js');
  const previous = process.env.SB_AD4Q_NO_DISCOVERY;
  process.env.SB_AD4Q_NO_DISCOVERY = '1';
  t.after(async () => {
    if (previous === undefined) delete process.env.SB_AD4Q_NO_DISCOVERY;
    else process.env.SB_AD4Q_NO_DISCOVERY = previous;
    await shutdownDiscovery();
  });
  await discoverDevices({ simulate: true });
  const adapter = createMonitoringAdapter({ id: SIM_DEVICE_ID, product: PRODUCT, config: { simulated: true } }, {});
  const { Ad4qDevice } = await import('../driver/ad4q/device.js');
  const originalRead = Ad4qDevice.prototype.readAll;
  Ad4qDevice.prototype.readAll = async () => { throw new Error('injected read failure'); };
  try {
    await assert.rejects(adapter.open(), /injected read failure/);
    assert.equal(adapter.unit, null);
    assert.equal(adapter.closed, true);
  } finally {
    Ad4qDevice.prototype.readAll = originalRead;
    await adapter.close();
  }
});
