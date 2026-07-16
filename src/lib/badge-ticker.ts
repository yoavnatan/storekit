// Lightweight odometer-style roll for header count badges (cart/wishlist/notif) —
// no animation library, just a 2-row reel transformed via CSS transition.
function tickBadge(el: HTMLElement, value: string): void {
  const prev = el.dataset.tickerValue;
  el.dataset.tickerValue = value;

  const prevNum = prev != null ? Number(prev.replace('+', '')) : NaN;
  const nextNum = Number(value.replace('+', ''));
  const direction: 'up' | 'down' | null =
    prev == null || Number.isNaN(prevNum) || Number.isNaN(nextNum) || prevNum === nextNum
      ? null
      : nextNum > prevNum ? 'up' : 'down';

  const newVal = document.createElement('span');
  newVal.className = 'badge-ticker__val';
  newVal.textContent = value;

  const track = document.createElement('span');
  track.className = 'badge-ticker__track';

  if (!direction) {
    track.appendChild(newVal);
    el.replaceChildren(track);
    return;
  }

  const oldVal = document.createElement('span');
  oldVal.className = 'badge-ticker__val';
  oldVal.textContent = prev ?? '';

  if (direction === 'up') track.append(oldVal, newVal);
  else track.append(newVal, oldVal);
  track.style.transform = direction === 'up' ? 'translateY(0%)' : 'translateY(-50%)';
  el.replaceChildren(track);

  track.getBoundingClientRect(); // force layout so the transition below actually runs
  requestAnimationFrame(() => {
    track.style.transform = direction === 'up' ? 'translateY(-50%)' : 'translateY(0%)';
  });
}

// Single entry point for all three header count badges (cart/wishlist/notif).
// `value === null` means "count is 0" — hide with a pop-out instead of an
// instant `hidden` flip. A badge going from hidden→visible pops in; a badge
// already visible whose number just changes only ticks (no re-pop), and an
// SSR-visible badge on first page load never pops (its dataset.tickerValue
// is seeded server-side, so the first client tick is a same-value no-op).
export function updateBadge(el: HTMLElement, value: string | null): void {
  if (value == null) {
    if (el.hidden) return;
    el.classList.add('badge-count--closing');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.hidden = true;
      el.classList.remove('badge-count--closing');
      delete el.dataset.tickerValue;
    };
    el.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 200);
    return;
  }

  const wasHidden = el.hidden;
  tickBadge(el, value);
  el.hidden = false;
  if (wasHidden) {
    el.classList.add('badge-count--entering');
    el.addEventListener('animationend', () => el.classList.remove('badge-count--entering'), { once: true });
  }
}
