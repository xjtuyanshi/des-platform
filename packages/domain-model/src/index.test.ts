import { Station } from './index.js';

describe('Station two-bin state machine', () => {
  it('switches bins and requests replenishment only once per emptied bin', () => {
    const station = new Station('S1', 1, 2, 0.5);

    const firstConsume = station.consumeOne(10);
    expect(firstConsume).toMatchObject({
      emptiedBinIndex: 0,
      requestBinIndex: 0,
      starvationStarted: false,
      consumed: 1
    });
    expect(station.activeBinIndex).toBe(1);
    expect(station.requestCount).toBe(1);

    const secondConsume = station.consumeOne(20);
    expect(secondConsume).toMatchObject({
      emptiedBinIndex: null,
      requestBinIndex: null,
      starvationStarted: false,
      consumed: 1
    });

    const refill = station.refillBin(0, 25);
    expect(refill).toEqual({
      starvationCleared: false,
      clearedDurationSec: 0
    });
    expect(station.bins[0].pendingRequest).toBe(false);

    const thirdConsume = station.consumeOne(30);
    expect(thirdConsume).toMatchObject({
      emptiedBinIndex: 1,
      requestBinIndex: 1,
      starvationStarted: false,
      consumed: 1
    });
    expect(station.activeBinIndex).toBe(0);
    expect(station.requestCount).toBe(2);
  });

  it('does not create duplicate requests while a bin remains empty and pending', () => {
    const station = new Station('S2', 2, 1, 1);

    const consumeA = station.consumeOne(0);
    expect(consumeA.requestBinIndex).toBe(0);
    expect(station.requestCount).toBe(1);

    const consumeB = station.consumeOne(10);
    expect(consumeB.requestBinIndex).toBe(1);
    expect(consumeB.starvationStarted).toBe(true);
    expect(station.requestCount).toBe(2);

    const repeatedEmptyConsume = station.consumeOne(20);
    expect(repeatedEmptyConsume).toMatchObject({
      emptiedBinIndex: 1,
      requestBinIndex: null,
      starvationStarted: false,
      consumed: 0
    });
    expect(station.requestCount).toBe(2);

    const refill = station.refillBin(0, 30);
    expect(refill).toEqual({
      starvationCleared: true,
      clearedDurationSec: 20
    });
    expect(station.isStarved).toBe(false);
    expect(station.bins[0].pendingRequest).toBe(false);
  });
});
