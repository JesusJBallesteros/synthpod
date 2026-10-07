/**
 * Piper's id layout: BOS, then every phoneme followed by a pad, then EOS. The ids must come from
 * the voice's own table: voices differ in which symbols they know, and an id a voice was not
 * trained with crashes inference, so unknown phonemes are dropped.
 */
export function toIds(phonemes: string[], config: { phoneme_id_map: Record<string, number[]> }): number[] {
  const map = config.phoneme_id_map;
  const pad = map['_'] ?? [0];
  const ids = [...(map['^'] ?? [1]), ...pad];
  for (const p of phonemes) {
    if (map[p]) ids.push(...map[p], ...pad);
  }
  ids.push(...(map['$'] ?? [2]));
  return ids;
}