import assert from 'node:assert/strict';
export class MemoryDb {
  values = new Map();
  tail = Promise.resolve();
  doc(path) {
    return {
      path,
      collection: (c) => ({ doc: (id) => this.doc(`${path}/${c}/${id}`) }),
      get: async () => this.snapshot(path),
      set: async (value) => this.values.set(path, structuredClone(value)),
      update: async (value) =>
        this.values.set(path, { ...this.values.get(path), ...value }),
    };
  }
  collection(c) {
    return { doc: (id) => this.doc(`${c}/${id}`) };
  }
  snapshot(path) {
    return {
      exists: this.values.has(path),
      data: () => structuredClone(this.values.get(path)),
    };
  }
  runTransaction(fn) {
    const operation = this.tail.then(async () => {
      const changes = [];
      let written = false;
      const result = await fn({
        get: async (ref) => {
          assert.equal(written, false, 'reads must precede writes');
          return this.snapshot(ref.path);
        },
        create: (ref, v) => {
          assert.equal(this.values.has(ref.path), false);
          written = true;
          changes.push([ref.path, v]);
        },
        set: (ref, v) => {
          written = true;
          changes.push([ref.path, v]);
        },
        update: (ref, v) => {
          assert.equal(this.values.has(ref.path), true, 'update needs a doc');
          written = true;
          changes.push([ref.path, { ...this.values.get(ref.path), ...v }]);
        },
      });
      for (const [path, value] of changes)
        this.values.set(path, structuredClone(value));
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
