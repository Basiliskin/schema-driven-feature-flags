import type { Snapshot } from '../domain/snapshot.js';

export class SnapshotStore {
  #current: Snapshot | undefined;
  #appliedTicket = 0;
  #issuedTickets = 0;

  get current(): Snapshot | undefined {
    return this.#current;
  }

  /** Reserves a slot in arrival order; only the newest slot's snapshot may be applied. */
  issueTicket(): number {
    return ++this.#issuedTickets;
  }

  replace(next: Snapshot, ticket: number): boolean {
    if (ticket <= this.#appliedTicket) return false;
    this.#appliedTicket = ticket;
    this.#current = next;
    return true;
  }
}
