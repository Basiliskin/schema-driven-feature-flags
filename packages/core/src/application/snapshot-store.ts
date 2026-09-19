import type { Segments } from '../domain/evaluation/evaluate.js';
import type { Snapshot } from '../domain/snapshot.js';

/** A snapshot and the segments it references, always replaced together. */
export interface ActiveSnapshot {
  readonly snapshot: Snapshot;
  readonly segments: Segments;
}

export class SnapshotStore {
  #current: ActiveSnapshot | undefined;
  #appliedTicket = 0;
  #issuedTickets = 0;

  get current(): ActiveSnapshot | undefined {
    return this.#current;
  }

  /** Reserves a slot in arrival order; only the newest slot's value may be applied. */
  issueTicket(): number {
    return ++this.#issuedTickets;
  }

  replace(next: ActiveSnapshot, ticket: number): boolean {
    if (ticket <= this.#appliedTicket) return false;
    this.#appliedTicket = ticket;
    this.#current = next;
    return true;
  }
}
