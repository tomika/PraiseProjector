export class MultiMap<K, V> extends Map<K, Set<V>> {
  add(key: K, value: V) {
    let set = this.get(key);
    if (!set) {
      set = new Set<V>();
      this.set(key, set);
    }
    set.add(value);
  }

  removeValue(key: K, pred: (value: V) => boolean) {
    const set = this.get(key);
    if (set) {
      for (const value of set) {
        if (pred(value)) {
          set.delete(value);
        }
      }
      if (set.size === 0) {
        this.delete(key);
      }
    }
  }

  getValues(key: K): V[] {
    const set = this.get(key);
    return set ? Array.from(set) : [];
  }
}
