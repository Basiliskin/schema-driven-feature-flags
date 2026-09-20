import { browseEnvironment, type BrowsePorts } from './browse-environment.js';
import type { SegmentUploadPorts } from './upload-segment.js';

export type ListReferencedSegmentsPorts = BrowsePorts & Pick<SegmentUploadPorts, 'readSegmentVersion'>;

export type SegmentListRow =
  | { readonly key: string; readonly state: 'published'; readonly version: number }
  | { readonly key: string; readonly state: 'not-published' }
  | { readonly key: string; readonly state: 'unavailable' };

const referencedKeys = (view: Awaited<ReturnType<typeof browseEnvironment>>): readonly string[] => {
  if (view.status === 'empty') return [];
  const { current } = view;
  if (current.status === 'not-available' || current.contents.status === 'invalid') return [];
  return current.contents.segmentKeys;
};

// Guarded per key so one unreadable Segment Pointer costs its own row, not the whole page.
const readRow = async (
  ports: ListReferencedSegmentsPorts,
  environment: string,
  key: string,
): Promise<SegmentListRow> => {
  try {
    const version = await ports.readSegmentVersion(environment, key);
    return version === null ? { key, state: 'not-published' } : { key, state: 'published', version };
  } catch {
    return { key, state: 'unavailable' };
  }
};

export async function listReferencedSegments(
  ports: ListReferencedSegmentsPorts,
  environment: string,
): Promise<readonly SegmentListRow[]> {
  const view = await browseEnvironment(ports, environment);
  return Promise.all(referencedKeys(view).map((key) => readRow(ports, environment, key)));
}
