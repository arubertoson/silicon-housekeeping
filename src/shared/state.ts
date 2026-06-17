import type { Named, UniqueStore } from "./store.js";

export interface State<T extends Named> {
  index: number;
  active: T | undefined;
  store: UniqueStore<T>;
}

function cycle<T extends Named>(state: State<T>, steps: number): T | undefined {
  let index = state.index + steps;
  const storeLen = state.store.length;

  // If store is empty we just exist, there is nothing to cycle.
  if (storeLen === 0) return undefined;

  if (index >= storeLen) index = 0;
  if (index < 0) index = storeLen - 1;

  state.index = index;
  state.active = state.store.getByIndex(index);

  return state.active;
}

export function next<T extends Named>(state: State<T>): T | undefined {
  return cycle(state, 1);
}
export function prev<T extends Named>(state: State<T>): T | undefined {
  return cycle(state, -1);
}
