import { Leader } from "./Leader";
import { leadersResponseCodec } from "../common/pp-codecs";
import { LeaderDBProfile } from "../common/pp-types";
import { decode } from "../common/io-utils";

export class Leaders {
  items: Leader[];

  constructor() {
    this.items = [];
  }

  static fromJSON(input: unknown): Leaders {
    const data = decode(leadersResponseCodec, input);
    const leaders = new Leaders();
    leaders.items = data.map((d) => Leader.fromJSON(d));
    return leaders;
  }

  clone(): Leaders {
    const newLeaders = new Leaders();
    newLeaders.items = this.items.map((l) => l.clone());
    return newLeaders;
  }

  equals(other: Leaders): boolean {
    if (!other || this.items.length !== other.items.length) {
      return false;
    }
    for (let i = 0; i < this.items.length; i++) {
      const thisLeader = this.items[i];
      const otherLeader = other.items[i];
      if (!thisLeader || !otherLeader || !thisLeader.equals(otherLeader)) {
        return false;
      }
    }
    return true;
  }

  add(leader: Leader) {
    this.items.push(leader);
  }

  remove(leader: Leader) {
    this.items = this.items.filter((l) => l.id !== leader.id);
  }

  find(id: string): Leader | undefined {
    return this.items.find((l) => l.id === id);
  }

  findByName(name: string): Leader | undefined {
    return this.items.find((l) => l.name === name);
  }

  addFromJSON(data: unknown): void {
    const leader = Leader.fromJSON(data);
    const existing = this.find(leader.id);
    if (existing) {
      this.remove(existing);
    }
    this.add(leader);
  }

  toJSON(): LeaderDBProfile[] {
    return this.items.map((l) => l.toJSON());
  }
}
