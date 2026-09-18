import type { Props } from './types';

// Anything a site would otherwise have to wire by hand: a marked element, a
// link that leaves the site, a link that downloads a file.
const FILE_TYPES = [
  'pdf', 'xlsx', 'docx', 'txt', 'rtf', 'csv', 'exe', 'key', 'pps', 'ppt', 'pptx',
  '7z', 'pkg', 'rar', 'gz', 'zip', 'avi', 'mov', 'mp4', 'mpeg', 'wmv', 'midi',
  'mp3', 'wav', 'wma', 'dmg',
];

const PROP_PREFIX = 'data-pa-prop-';

export function elementProps(el: Element): Props | undefined {
  const attrs = el.attributes;
  const props: Props = {};
  let found = false;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs.item(i);
    if (attr !== null && attr.name.indexOf(PROP_PREFIX) === 0) {
      props[attr.name.slice(PROP_PREFIX.length)] = attr.value;
      found = true;
    }
  }
  return found ? props : undefined;
}

export function linkEvent(link: HTMLAnchorElement, hostname: string): string | null {
  if (!/^https?:/i.test(link.href)) {
    return null;
  }
  if (link.hostname !== hostname) {
    return 'outbound_link';
  }
  const path = link.pathname;
  const dot = path.lastIndexOf('.');
  if (dot > 0 && FILE_TYPES.indexOf(path.slice(dot + 1).toLowerCase()) >= 0) {
    return 'file_download';
  }
  return null;
}

export function watchClicks(
  doc: Document,
  hostname: string,
  track: (name: string, props?: Props) => void,
): void {
  doc.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const tagged = target.closest('[data-pa-event]');
      if (tagged !== null) {
        const name = tagged.getAttribute('data-pa-event');
        if (name !== null && name !== '') {
          track(name, elementProps(tagged));
        }
      }
      const link = target.closest('a');
      if (link !== null) {
        const name = linkEvent(link, hostname);
        if (name !== null) {
          track(name, { url: link.href });
        }
      }
    },
    true,
  );
}
