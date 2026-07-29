export type RandomFn = () => number;

/** Deterministic PRNG (mulberry32) so engine/feed behavior is reproducible in
 * tests and so independent simulated reporter nodes can each have their own
 * stable, distinct stream without pulling in a dependency. Not cryptographic
 * -- only used for simulating market noise, never for signing. */
export function mulberry32(seed: number): RandomFn {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
