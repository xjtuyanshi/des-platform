import { AiNativeDesLibraryCatalog } from './library-catalog.js';

describe('AI-native DES library catalog', () => {
  it('documents the core Process Flow and Material Handling primitives for AI authoring', () => {
    const entryIds = new Set(AiNativeDesLibraryCatalog.entries.map((entry) => entry.id));

    expect(AiNativeDesLibraryCatalog.schemaVersion).toBe('des-platform.library-catalog.v1');
    expect([...entryIds]).toEqual(expect.arrayContaining([
      'process.source',
      'process.service',
      'process.assign',
      'process.selectOutput',
      'process.moveByTransporter',
      'process.store',
      'process.retrieve',
      'process.convey',
      'material.layout',
      'experiment.replication-sweep'
    ]));
    expect(AiNativeDesLibraryCatalog.entries.every((entry) => entry.parameters !== undefined && entry.constraints.length > 0)).toBe(true);
  });
});
