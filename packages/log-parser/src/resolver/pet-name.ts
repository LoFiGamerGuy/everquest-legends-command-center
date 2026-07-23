/**
 * Generated-pet-name pattern (docs/PRIOR_ART.md — rumstil/eqlogparser;
 * docs/LOG_FORMAT_SPEC.md §3 "grammar conventions").
 *
 * Classic EQ pets are auto-named from a small phonotactic generator. The
 * community-documented pattern (rumstil, Apache-2.0 — ported as documented
 * behaviour, not copied source) is:
 *
 *   ^[GJKLVXZ]([aeio][bknrs]){0,2}(ab|er|n|tik)$
 *
 * A match is **weak evidence** that a bare name is pet-SHAPED. Per our policy
 * (see EntityResolver docstring) this is a KIND hint only — it says "this looks
 * like a pet", never "this is *your* pet". It therefore carries the
 * `name_pattern` weight (0.4, ADR-006) and NEVER, on its own, establishes a
 * pet -> owner link or rolls damage up to an owner.
 */

/** Anchored generated-pet-name pattern. Test against a bare, single-token name. */
export const GENERATED_PET_NAME = /^[GJKLVXZ]([aeio][bknrs]){0,2}(ab|er|n|tik)$/;

/** True when `name` is shaped like an EQ generated pet name (weak signal only). */
export function looksLikeGeneratedPetName(name: string): boolean {
  return GENERATED_PET_NAME.test(name.trim());
}
