# Evaluation semantics

This is the cross-language contract for evaluating one feature from a snapshot against an evaluation
context. Every SDK must reproduce it exactly. [`evaluation-vectors.json`](evaluation-vectors.json) is
the executable form of this document: each rule below names the vectors that pin it down, and an SDK
conforms when it passes every vector.

## Inputs and result

`evaluate(feature, context)` takes one feature object from a snapshot (`features.<key>`) and a
context, and returns:

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
3. **Rules, in order.** The first rule whose `when` matches wins: boolean features return the
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
