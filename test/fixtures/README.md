# Test fixtures

`plan.ics` and `plan.html` are cut from a real plan published by NORDAKADEMIE
(two study weeks of one Zenturie), because the value of these fixtures is that
they exercise the feed's genuine quirks — the comma-jammed `SUMMARY`, folded
lines that split words mid-token, three parallel Englisch groups, co-teaching
that must *not* split, and a real room substitution with sked's own wording.

**Lecturer names have been replaced with invented ones**, consistently across
both files. Nothing else was altered: times, rooms, course titles, event ids,
folding and the change annotations are exactly as published.

Any resemblance between the names here and real teaching staff is accidental.

The tests assert on structure — how many parallel sections exist, that each is
internally free of clashes, that a substitution parses — rather than on the
names themselves, so re-pseudonymising the fixtures would not break them.
