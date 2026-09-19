# Evaluation semantics

This is the cross-language contract for evaluating one feature from a snapshot against an evaluation
context. Every SDK must reproduce it exactly. [`evaluation-vectors.json`](evaluation-vectors.json) is
the executable form of this document: each rule below names the vectors that pin it down, and an SDK
conforms when it passes every vector. A vector may also carry `flagKey` (the feature's key in the
snapshot), `segments` (segment key to member list) and `bucket` (the expected bucket of the first
rule with a rollout, so a wrong hash cannot pass by luck).

## Inputs and result

`evaluate(feature, context, segments)` takes one feature object from a snapshot (`features.<key>`),
a context, and the segments the SDK currently holds (a map from segment key to its member set; see
[Segments](#segments)), and returns:

| Field | Meaning |
|---|---|
| `value` | Boolean feature: whether it is on. Config feature: the resolved JSON value. |
| `enabled` | Boolean feature: equals `value`. Config feature: the feature's `enabled` flag. |
| `reason` | `DISABLED`, `RULE_MATCH`, `DEFAULT` or `INVALID_CONTEXT`. |
| `ruleIndex` | Zero-based index of the matched rule. Present only when `reason` is `RULE_MATCH`. |

Evaluation is pure: no I/O, no clock, no randomness, no caching. The same feature and context always
give a deep-equal result, and neither input is modified.

## Order of evaluation

1. **Disabled.** If `feature.enabled` is `false`, return `DISABLED` without looking at rules or
   context. Boolean features return `false`; config features return `default`.
   Vectors: `disabled-boolean-ignores-rules`, `disabled-config-returns-default`.
2. **Context validation** (optional; SDK-specific). An SDK that knows the feature's context schema
   validates the context first. If validation fails it returns the fallback (step 4) with reason
   `INVALID_CONTEXT`. Schemas are not part of the snapshot, so no shared vector covers this step.
3. **Rules, in order.** The first rule whose `when` matches, and whose context is
   [in its rollout](#percentage-rollout) when it has one, wins: boolean features return the
   rule's `enabled`; config features return the rule's `value`.
   Vectors: `boolean-rule-match`, `rule-can-switch-off`, `first-matching-rule-wins`,
   `later-rule-matches-when-earlier-does-not`, `config-rule-match-returns-rule-value`,
   `config-value-false-is-still-enabled`.
4. **Fallback**, reason `DEFAULT`. Config features return `default`. Boolean features return `true`
   when they have no rules and `false` when they have rules and none matched: rules target an
   audience, and anyone outside it is off.
   Vectors: `boolean-without-rules-is-on`, `boolean-with-rules-and-no-match-is-off`,
   `config-without-match-returns-default`.

## Conditions

A rule's `when` maps attribute names to conditions. All entries must match (AND). An empty `when`
matches every context. Vectors: `keys-combine-with-and-all-match`, `keys-combine-with-and-one-fails`,
`empty-when-always-matches`.

A condition is either a scalar (shorthand for `equals`) or an object with exactly one operator:

| Operator | Operand | Matches when the attribute value |
|---|---|---|
| `equals` | scalar | is the same type and the same value as the operand |
| `notEquals` | scalar | is not `equals` to the operand |
| `in` | non-empty array of scalars | `equals` at least one element |
| `inSegment` | segment key (string) | has a [canonical string](#canonical-string) that is a member of the segment |

A scalar is a string, a boolean, or a finite number.

### Attribute lookup

- The context is a JSON object. Anything else (`null`, an array, a string) has no attributes.
  Vectors: `non-object-context-has-no-attributes`, `null-context-still-matches-empty-when`,
  `array-context-has-no-attributes`.
- Only the context's own properties count; inherited ones (such as `constructor` in JavaScript) are
  missing.
- **A condition on a missing or non-scalar attribute never matches, for every operator, including
  `notEquals`.** Non-scalar means `null`, an object, an array, or a non-finite number. Evaluation
  never throws because of the context.
  Vectors: `missing-attribute-does-not-match`, `missing-attribute-does-not-match-not-equals`,
  `null-attribute-does-not-match`, `object-attribute-does-not-match`, `array-attribute-does-not-match`.

### Comparison

Comparison is strict. There is no type coercion and no case folding: `5` does not equal `"5"`, `true`
does not equal `"true"`, and `"IL"` does not equal `"il"`. Numbers compare by value, so `18` equals
`18.0`. Because `notEquals` is the negation of `equals` on a present scalar, `5` is `notEquals` `"5"`.
Vectors: `equals-is-type-strict-number-vs-string`, `equals-is-type-strict-boolean-vs-string`,
`equals-is-case-sensitive`, `equals-compares-numbers-by-value`, `explicit-equals-operator`,
`not-equals-matches-other-value`, `not-equals-rejects-same-value`, `not-equals-matches-different-type`,
`in-matches-listed-value`, `in-rejects-unlisted-value`, `in-is-type-strict`.

An SDK that meets an operator it does not know (from a newer snapshot) treats the condition as not
matching; it does not fail.

## Snapshot schema version

A snapshot that uses any `inSegment` condition or any rule `rollout` must have `schemaVersion: 2`.
A snapshot without them may use `1` or `2`; both mean the same thing, and a version-2 snapshot with
no segment or rollout field is valid. An SDK that supports segments and rollouts accepts both
versions.

An SDK that only knows version 1 rejects a version-2 snapshot as invalid. It never drops the rules it
does not understand: at startup it fails to start (`StartupError`); after startup it logs the
rejection and keeps serving its last good snapshot (see [s3-layout.md](s3-layout.md#failure-modes)).
Upgrade every SDK before publishing the first version-2 snapshot.

## Canonical string

Segment membership and rollout bucketing both turn an attribute value into a string first:

| Attribute value | Canonical string |
|---|---|
| string | the string itself, unchanged (no trimming, no case folding, no Unicode normalization) |
| integer from -9007199254740991 to 9007199254740991 | decimal digits with a leading `-` when negative; no `+`, fraction, exponent or leading zeros (`18.0` → `"18"`, `-0` → `"0"`) |
| anything else | none |

"Anything else" is a boolean, a number with a fraction, a larger integer, `null`, an object, an
array, or a missing attribute. A value with no canonical string is never a segment member and never
in a rollout. This avoids number formatting that differs across languages (`1.0`, `1e21`).

## Segments

A segment is a set of member strings uploaded separately from snapshots and stored under its own
key (layout in [s3-layout.md](s3-layout.md#segments)). A snapshot refers to a segment only by key,
through the `inSegment` operator:

```json
{ "when": { "userId": { "inSegment": "beta-testers" } }, "enabled": true }
```

The condition matches when the context attribute (`userId` here) has a canonical string and that
string is in the segment's `members`. Comparison is exact and case-sensitive.

**Fail-safe.** A segment problem never widens who gets a flag, and never throws:

- The segment is missing (not uploaded, not loaded yet, or never fetched): the condition does not
  match.
- The segment file is invalid or over the member limit: the SDK rejects it and treats the segment as
  missing, unless it already holds an earlier valid version of that segment, which it keeps using.
- The attribute has no canonical string: the condition does not match.

Vectors: `in-segment-member-matches`, `in-segment-non-member-does-not-match`,
`in-segment-is-case-sensitive`, `in-segment-missing-segment-does-not-match`,
`in-segment-integer-uses-canonical-string`, `in-segment-fraction-has-no-canonical-string`,
`in-segment-missing-attribute-does-not-match`, `in-segment-missing-segment-falls-through-to-next-rule`.

There is no negated segment operator. `not inSegment` would turn a missing segment into "everyone",
so it is deliberately left out; an SDK that meets an unknown operator already treats it as not
matching.

## Percentage rollout

A rule may carry a `rollout`. It then applies only to the share of contexts whose bucket falls
inside the percentage:

```json
{
  "when": { "country": "IL" },
  "rollout": { "percentage": 25, "bucketBy": "userId", "salt": "2026-q3" },
  "enabled": true
}
```

| Field | Rule |
|---|---|
| `percentage` | Number from `0` to `100` with at most two decimal places (`12.5`, `0.25`). |
| `bucketBy` | Non-empty attribute name whose value decides the bucket. |
| `salt` | Non-empty string. Changing it reshuffles every context; keep it fixed for the life of a rollout. |

A snapshot whose `rollout` breaks any of these rules, has extra fields, or whose `inSegment` operand
is not a valid [segment key](s3-layout.md#segments) is invalid as a whole and rejected at load time,
like any other invalid snapshot; no rule is silently dropped.

A rule with a rollout wins only when its `when` matches **and** the context is in the rollout. A
context whose `when` matches but whose bucket is outside the rollout falls through to the next rule,
and to the [fallback](#order-of-evaluation) when no later rule wins. It is never switched off by the
rollout rule itself.
Vectors: `rollout-applies-only-after-when-matches`, `rollout-miss-falls-through-to-next-rule`,
`rollout-miss-falls-through-to-default`, `rollout-miss-does-not-apply-switch-off-rule`,
`segment-and-rollout-combine`.

### Bucket

1. Take the canonical string of the `bucketBy` attribute. With none (missing, `null`, boolean,
   fraction, object, array), the context is **not in the rollout**.
2. Build the input `<flagKey>:<salt>:<value>` — the feature's key in the snapshot, the salt and the
   canonical string, joined by `:` in that order — and encode it as UTF-8 bytes.
3. Hash the bytes with **MurmurHash3 x86 32-bit** (`murmur3_32`), seed `0`, and read the result as
   an **unsigned** 32-bit integer (0 to 4294967295). A language with signed 32-bit integers must
   convert (`h & 0xFFFFFFFF` or `h >>> 0`) before the next step.
4. `bucket = hash mod 10000`, an integer from 0 to 9999.
5. The context is in the rollout when `bucket < round(percentage × 100)`. `round` removes
   floating-point error (`0.29 × 100` is `28.999999999999996`), so the threshold is an exact integer
   from 0 to 10000. `0` puts no one in, `100` puts everyone in.

The same flag key, salt and value always give the same bucket, on every SDK and every host. Raising
the percentage only adds contexts; it never removes one that was already in. There is no stored
assignment and no randomness, so evaluation stays pure.

Worked examples (feature key `new-checkout`, salt `2026-q3`):

| `bucketBy` value | Hash input | `murmur3_32` (unsigned) | Bucket | In at 25%? | In at 70%? |
|---|---|---|---|---|---|
| `"user-42"` | `new-checkout:2026-q3:user-42` | 4244106247 (`0xfcf7ec07`) | 6247 | no | yes |
| `12345` | `new-checkout:2026-q3:12345` | 2457201891 (`0x9275ece3`) | 1891 | yes | yes |
| `"ünïcødé"` | `new-checkout:2026-q3:ünïcødé` | 3540490230 (`0xd30797f6`) | 230 | yes | yes |
| `12345.5` | none | — | — | no | no |

To check a `murmur3_32` implementation: `"hello"` hashes to 613153351 (`0x248bfa47`) and the empty
input to `0`.

Vectors: `rollout-zero-percent-puts-no-one-in`, `rollout-hundred-percent-puts-everyone-in`,
`rollout-boundary-below-bucket-is-out`, `rollout-boundary-at-bucket-is-out`,
`rollout-boundary-above-bucket-is-in`, `rollout-monotonic-in-at-25`, `rollout-monotonic-still-in-at-70`,
`rollout-hashes-utf8-bytes-out`, `rollout-hashes-utf8-bytes-in`, `rollout-missing-bucket-by-is-out`,
`rollout-fraction-bucket-by-is-out`, `rollout-boolean-bucket-by-is-out`.
