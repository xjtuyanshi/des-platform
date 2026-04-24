import { Station } from './index.js';

describe('Station 2-bin logic', () => {
  it('opens only one request per empty bin and switches to alternate stock', () => {
    const station = new Station('S1', 1, 3, 1);

    expect(station.activeBinIndex).toBe(0);

    station.consumeOne(0);
    station.consumeOne(40);
    const result = station.consumeOne(80);

    expect(result.requestBinIndex).toBe(0);
    expect(station.requestCount).toBe(1);
    expect(station.activeBinIndex).toBe(1);

    const repeat = station.consumeOne(120);
    expect(repeat.requestBinIndex).toBeNull();
    expect(station.requestCount).toBe(1);
  });
});
