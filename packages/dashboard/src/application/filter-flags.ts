/** What the filter matches against; the flag views from browse-environment satisfy it. */
export interface FilterableFlag {
  readonly key: string;
  readonly type: string;
  readonly enabled: boolean;
}

/** The same string the flag row carries in data-search, so the server and the browser filter identically. */
const haystack = (flag: FilterableFlag): string =>
  `${flag.key} ${flag.type} ${flag.enabled ? 'on' : 'off'}`.toLowerCase();

// Plain substring matching is kept deliberately, quirks included, so existing filters return what they return today:
// the term 'on' matches any flag whose key or type merely contains those letters — every 'config' flag, and any key
// like 'onboarding' — so filtering 'on' also returns flags that are off. ('off' does not contain 'on'; the overlap
// runs the other way.)
export const filterFlags = <T extends FilterableFlag>(flags: readonly T[], filterText: string): readonly T[] => {
  const terms = filterText.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return flags;
  return flags.filter((flag) => {
    const text = haystack(flag);
    return terms.every((term) => text.includes(term));
  });
};
