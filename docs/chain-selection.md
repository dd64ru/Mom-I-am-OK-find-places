# Exact venues and related locations

The production regression exposed two separate gaps: the recognized brand/aliases could displace the prominent full storefront sign before Google search, and the shortlist could only confirm one venue. Recognition now supports bounded `clue.signage` (150 characters), tied to the public venue clue. Vision must preserve the prominent primary sign, normalizing line breaks to spaces, and exclude private/incidental OCR. Search planning reserves its first existing slot for the strongest signage-backed identity, including after cited enrichment; arbitrary visibleText is never queried.

Candidate application metadata distinguishes `likely_exact`, `plausible_exact`, and `related_chain_location` (with `related_branch` reserved). With signage, full exact/reordered sign evidence earns likely_exact; a different concept/location matching a supported possibleChain receives the related label. Related candidates always rank below exact/plausible photographed-venue candidates. Without signage, the existing discrete meaningful identity classes continue to work. Generic-only names cannot authorize identity or chain membership. Weak query-relevant candidates may still be possible variants, without being promoted into chain members.

Related inference requires structured Recognition.possibleChain with meaningful identity, a bounded whole-token brand anchor (at most three added provider tokens), and compatible/related category. It is a discovery-time hypothesis, not an authoritative Google chain claim. ChainSchema/saveChain/getChain remain available but do not represent uncertain membership/provenance; this workflow therefore does not automatically write Chain records or chainId onto Places.

An attempt retains a transient provider scope across phases (including the production image-processing wrapper). At most two initial plus two enriched Text Search requests remain available. At most **one** additional related-location query is allowed, only with supported brand identity and one unambiguous provider city. It searches that brand's locations in the known city, enforcing city and country again. There is no group-wide discovery loop. Each response processes ten rows; slots are bounded at fifty. Related results share the same ID deduplication map. Different IDs remain separate branches. The display/persistence selection bound is **eight** candidates.

## City intent and display

A city correction makes one separate bounded linguistic normalization call (20 seconds, no tools, no web search, no venue input). Only high-confidence aliases bound to that exact accepted city are used. Venue verification success/citations are not required. Model uncertainty does not invent geography. Cross-script provider/user text without common comparable aliases remains unknown; known comparable city/country or street-number contradictions still exclude results. No city or transliteration lookup table is added.

Provider city display is independent of semantic intent comparison. Reliable locality/postal components may be rendered as “Город по данным Google” even when user/provider equivalence is unknown. Place Details refresh requests addressComponents for that purpose. Provider city/content remains transient.

## Telegram and persistence

One eligible candidate produces a singular explicit-confirmation card, including a low-confidence related/weak result. Legacy pending one-item shortlists are upgraded to that same state with a new revision.

Two to eight candidates produce one coherent menu with transient names, city/address, Maps links, Google attribution and exact/possible/related labels. Checkboxes, Select all and Clear selection only update `selectedCandidateIndices`; they retain every candidate and create no Place. Each update increments the discovery revision, replaces opaque callback tokens and edits the same menu. Old/sibling/replayed callbacks are fenced by message, revision, expiry and leases. An interrupted refresh resumes the applied selection rather than toggling twice. Google content is refreshed by ID after lost transient memory; it is never copied into interaction documents. The menu enforces Telegram's 4000-character text budget and never truncates Maps links silently.

“Добавить выбранные (N)” is the final confirmation action. One bounded Firestore transaction reads all selected Place identities first, validates all records, creates only absent Places, then marks the discovery confirmed. Any failure rolls back the entire batch. Repeats reuse deterministic canonicalPlaceId identities and cannot create duplicates; existing user labels are preserved.

`confirmedPlaceIds` records all confirmed IDs. Optional legacy `confirmedPlaceId` continues to hold the first confirmed ID for old consumers; old single-place documents parse without migration. New multi-confirmations retain the full candidate list plus selection indices, allowing each confirmed identity to be associated with its independent evidence. Backfill reads all confirmed IDs, matches provider identity, and never copies the photographed branch label to related locations. Projection still operates on independent canonical Place documents and refreshes Google content by ID; its architecture is unchanged.

Durable Google Places retain only identity, permitted references and independently sourced application labels. Google display names, addresses, coordinates, types and attribution content are absent from Place/Discovery/interaction documents. Related relationship/confidence enums are application metadata on Discovery, not permanent provider content or verified chain membership.

## Diagnostics

Existing per-attempt candidateSlot/repetition diagnostics remain content-free and now include relationship and google_related_pass. Row decisions distinguish eligible related locations from insufficient identity. Selection events contain selectedCount only; confirmation events contain confirmedCount and reusedCount. No venue/city/query text, addresses, coordinates, Place IDs, raw payloads, credentials or Telegram content are logged.

Synthetic regressions cover full signage priority, exact-first related ranking, bounded expansion, unknown-script city display and independent normalization, generic/unrelated exclusion, retained checkbox lists, multiple selections/all/clear, eight-place atomic confirmation and rollback/retry, reuse, singular/legacy behavior, multi-place backfill/projection and licensing/privacy boundaries.
