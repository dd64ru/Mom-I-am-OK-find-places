import {
  identityStrength,
  GOOGLE_MATCH_MARGIN,
  type NameMatch,
  type categorySupport,
} from './place-matching.js';
export type CandidateEvidence = NameMatch & {
  localityState: 'match' | 'unknown' | 'conflict';
  countryState: 'match' | 'unknown' | 'conflict';
  addressState: 'match' | 'absent' | 'conflict';
  categoryState: ReturnType<typeof categorySupport>;
  verifiedWeb: boolean;
  providerRank: number;
  finalRank: number;
};
export type CandidateDecision =
  | 'accepted_strong_identity'
  | 'accepted_partial_with_locality'
  | 'accepted_partial_with_address'
  | 'accepted_partial_with_web'
  | 'accepted_partial_with_category'
  | 'rejected_hard_conflict'
  | 'ambiguous_competition'
  | 'shortlist_required'
  | 'accepted_partial_uncorroborated'
  | 'insufficient_identity';
export const hardConflict = (e: CandidateEvidence) =>
  e.localityState === 'conflict' ||
  e.countryState === 'conflict' ||
  e.addressState === 'conflict';
export function identityDecision(e: CandidateEvidence): CandidateDecision {
  if (hardConflict(e)) return 'rejected_hard_conflict';
  if (identityStrength(e.nameEvidence) === 3) return 'accepted_strong_identity';
  if (identityStrength(e.nameEvidence) !== 2) return 'insufficient_identity';
  if (e.localityState === 'match') return 'accepted_partial_with_locality';
  if (e.addressState === 'match') return 'accepted_partial_with_address';
  if (e.verifiedWeb) return 'accepted_partial_with_web';
  if (e.categoryState === 'compatible' || e.categoryState === 'related')
    return 'accepted_partial_with_category';
  return 'accepted_partial_uncorroborated';
}
export type CandidateConfidence = 'high' | 'medium' | 'low';
// Missing evidence lowers confidence; only contradictions or competition veto.
export function candidateConfidence(e: CandidateEvidence): CandidateConfidence {
  if (identityStrength(e.nameEvidence) === 3)
    return e.localityState === 'match' ? 'high' : 'medium';
  return e.localityState === 'match' ||
    e.addressState === 'match' ||
    e.verifiedWeb
    ? 'medium'
    : 'low';
}
export const isAccepted = (d: CandidateDecision) => d.startsWith('accepted_');
const locationStrength = (e: CandidateEvidence) =>
  Number(e.localityState === 'match') + Number(e.addressState === 'match');
// Identity class takes precedence. Category/provider ordering cannot choose a branch.
export function compareEvidence(
  a: CandidateEvidence,
  b: CandidateEvidence,
): number {
  return (
    identityStrength(b.nameEvidence) - identityStrength(a.nameEvidence) ||
    locationStrength(b) - locationStrength(a) ||
    b.finalRank - a.finalRank
  );
}
export function decideCandidate(
  top: CandidateEvidence,
  runner?: CandidateEvidence,
  truncated = false,
): CandidateDecision {
  const decision = identityDecision(top);
  if (!isAccepted(decision)) return decision;
  if (truncated) return 'ambiguous_competition';
  if (
    !runner ||
    identityStrength(top.nameEvidence) > identityStrength(runner.nameEvidence)
  )
    return decision;
  // Even an uncorroborated partial runner can be a competing branch.
  const topLocation = locationStrength(top);
  const runnerLocation = locationStrength(runner);
  if (
    topLocation > runnerLocation &&
    (identityStrength(top.nameEvidence) === 2 ||
      top.finalRank - runner.finalRank >= GOOGLE_MATCH_MARGIN)
  )
    return decision;
  return 'ambiguous_competition';
}
export type GoogleDecisionEvent = {
  event: 'google_places_decision';
  phase: 'google_first_pass' | 'google_enriched_pass';
  query: number;
  nameEvidence: NameMatch['nameEvidence'];
  nameRankPermille: number;
  localityState: CandidateEvidence['localityState'];
  countryState: CandidateEvidence['countryState'];
  addressState: CandidateEvidence['addressState'];
  categoryState: CandidateEvidence['categoryState'];
  finalRankPermille: number;
  runnerUpRankPermille: number;
  decision: CandidateDecision;
  candidateConfidence: CandidateConfidence | undefined;
};

export type GoogleCandidateEvent = Omit<
  GoogleDecisionEvent,
  'event' | 'runnerUpRankPermille' | 'decision'
> & {
  event: 'google_places_candidate';
  candidateSlot: number;
  providerRank: number;
  seenInMultipleQueries: boolean;
  decision: CandidateDecision | 'eligible_weak_alternative';
};
