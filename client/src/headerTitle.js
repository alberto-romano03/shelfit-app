// Once a page's title has scrolled away under the header, the logo gives its place to the
// title, so you always know what you are looking at. One title at a time: the next page's
// call replaces the last one.

let header = null;
let label = null;
let stop = null;

export function mountHeaderTitle(host) {
  header = host;
  label = document.createElement('span');
  const node = document.createElement('div');
  node.className = 'header-title';
  // A repeat of the page's own heading, so screen readers shouldn't hear it twice.
  node.setAttribute('aria-hidden', 'true');
  node.append(label);
  host.append(node);
}

// Returns the cleanup, for the router's onCleanup.
export function followTitle(titleEl, text) {
  if (stop) stop();
  if (!header || !titleEl || typeof IntersectionObserver !== 'function') return () => {};
  label.textContent = text || '';
  const observer = new IntersectionObserver(
    ([entry]) => {
      // A title replaced by a fresher copy of the page reports as out of view too.
      if (!titleEl.isConnected) return;
      const gone = !entry.isIntersecting && entry.boundingClientRect.bottom <= entry.rootBounds.top;
      header.classList.toggle('has-title', gone);
    },
    { rootMargin: `-${header.offsetHeight}px 0px 0px 0px` }
  );
  observer.observe(titleEl);
  const end = () => {
    observer.disconnect();
    header.classList.remove('has-title');
    if (stop === end) stop = null;
  };
  stop = end;
  return end;
}
