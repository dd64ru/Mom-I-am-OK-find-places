# Featured public venues and safe resolution

This corrective branch starts at `a340009edaf9610b5c14ddac3b92152286f31b60`.

One explicitly named attraction in an image is a single target, even when its caption
has a series number. The Vision instruction now says so, and the fresh recognition
adapter normalizes a one-entry recommendation list to `single_venue`. It preserves
textual/native identities, bounded aliases, confidence and chain evidence. The
historical Recognition decoder and explicit single-brand APIs remain readable.
Several distinct visible recommendations still use selection and multi-selection;
a genuine single-chain request can use the normal chain path, and a skyline request
for the camera location keeps its viewpoint semantics. Missing evidence does not
silently become a different search task.

Normal resolution keeps two queries per phase. It prioritizes different
native/canonical identities of the primary clue before competing readings. The
existing cited enrichment pathway remains bounded; Google name, identity and
geography checks still decide the candidate. Generic viewpoint descriptors cannot
supply distinctive identity by themselves. Models supply no IDs or coordinates.
No venue-specific aliases, lookup tables, persistent-data migration or provider-cost
increase were added. Existing geographic conflicts, coordinate correction and
transient Google-content storage boundaries remain in force.

The supplied production summaries establish zero accepted identities and name
mismatches in recommendation mode. Source inspection establishes one query per
selected brand (`nativeName || name`) and the bypass of optional web enrichment
for that mode. The raw recognition/query/candidate payloads are unavailable; the
summaries do not establish that a valid Google candidate was discarded or that any
suggested alternative name is the same venue. Synthetic fixtures demonstrate the
mechanism only, not a successful resolution for the actual production screenshot.

`service_prepare_started` and `service_prepare_result` log the request key,
deterministic discovery ID and result/revision. The App logs the same key at
preparation/review start, unknown outcomes and completion. These events distinguish
preparation from later review without logging venue text, images or provider display
content. They do not retroactively correlate earlier production requests.

Focused deterministic verification includes fresh Vision parsing through both
provider adapters, discovery and Telegram presentation, city and multi-selection,
provider-backed native/cited identity resolution, deceptive descriptor near-matches,
geographic conflicts, unresolved outcomes, explicit confirmation, and existing
coordinate/storage contracts. No live provider calls, deployment or production
mutation belong to this corrective pass. Final commands/results and both repository
commit links are reported together by the App corrective-pass report.
