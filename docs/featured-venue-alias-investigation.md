# Featured viewpoint alias investigation

Baseline: `f46d3607f9552bb741c057b5d525c01d2fa245c5`.

The reported Magnolia screenshot failure is **not reproducibly established**.
There is no original structured Vision response, provider response or rejection
trace in the supplied evidence, and this investigation uses no production reads
or live provider calls. The screenshot itself was not supplied as image bytes.

Focused synthetic fixtures in `tests/featured-venue.test.mjs` exercise the real
DiscoveryService, FreshRecognition normalization, GooglePlacesPoi and Telegram
source with local Vision, web and Google transport doubles:

- One numbered `Juniper Viewing Platform` in Vesper normalizes from
  recommendation-list to single-venue and resolves Google's prefixed
  `The Stage Juniper Viewing Platform` to human confirmation. Literal equality
  is already unnecessary; distinctive-name partial matching accepts the prefix.
- With no first-pass provider results, cited independent web evidence associating
  that recognition with `The Lantern Observation Deck` enables the enriched
  provider search and human confirmation. This is a stronger nonliteral alias
  bridge than the reported prefix alone requires.
- `Viewing Platform`, `Observation Deck` and `Terrace` alone remain unresolved,
  even with a provider venue in the same city.
- Two provider identities with the supported title remain human alternatives.
  An explicit conflicting city returns `locality_mismatch`.

The existing tests also exercise Telegram review rendering, uncited identity
rejection, country conflicts and bounded native-name/alias queries. Google titles
remain transient: persisted candidates contain provider identity and references,
not canonical provider display content. No save occurs during discovery.

A single-venue recognition's cityHint is not itself the explicit search-city
boundary; current search planning uses explicit city, scene geography or selected
recommendation city. The conflict regression intentionally supplies explicit city.
This observation does not establish the incident cause: the synthetic single
numbered venue already resolves, and the independently verified enriched case
establishes geography without a user city override.

No resolver or recognition implementation was changed. Possible incident stages
still include actual Vision recognition, empty/different provider results, absent
verification evidence or geography. A future investigation needs those original
bounded outputs before attributing a rejection or expanding resolver scope. No
venue/city exception, nearest fallback, broader matching or confirmation change
is introduced here.
