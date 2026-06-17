export interface Named {
  name: string;
}

export class UniqueStore<T extends Named> {
  private items: Record<string, T> = {};
  private list: string[] = [];

  get length(): number {
    return this.list.length;
  }

  add(item: T): void {
    const name = item.name;
    if (this.items[name]) return;

    this.items[name] = item;
    this.list.push(name);
  }

  getByName(name: string): T {
    const item = this.items[name];

    if (!item) {
      throw new Error(`UniqueStore state invalid, ${name} not found in record.`)
    }

    return item
  }

  getByIndex(index: number): T {
    const name = this.list[index];

    if (!name) {
      throw new Error(`UniqueStore state invalid, ${index} not found in list.`)
    }

    return this.items[name];
  }

  merge(other: UniqueStore<T>): void {
    for (const name of other.list) {
      const preset = other.getByName(name);

      if (!preset) {
        throw new Error(`Preset not found ${name}.`);
      }

      this.add(preset);
    }
  }
}
