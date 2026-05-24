import { onBeforeUnmount, ref, watch, type ComputedRef, type Ref, computed } from "vue";

export interface DomScrollAdapter {
  position: ComputedRef<number>;
  range: ComputedRef<number>;
  viewportSize: ComputedRef<number>;
  onScrollTo: (pos: number) => void;
  onPageBy: (dir: -1 | 1) => void;
}

/**
 * Bind a `<Scrollbar>` to an `HTMLElement` whose content overflows. The
 * element keeps native scrollability (wheel, keyboard, programmatic
 * `scrollTop`); we just read its scroll metrics back out for the custom
 * scrollbar to render against. Add `class="scrollbar-none"` on the target to
 * hide the OS-rendered scrollbar.
 *
 * Units are CSS pixels.
 */
export function useDomScroll(target: Ref<HTMLElement | null>): DomScrollAdapter {
  const scrollTop = ref(0);
  const scrollHeight = ref(0);
  const clientHeight = ref(0);

  function snapshot(): void {
    const el = target.value;
    if (!el) {
      scrollTop.value = 0;
      scrollHeight.value = 0;
      clientHeight.value = 0;
      return;
    }
    scrollTop.value = el.scrollTop;
    scrollHeight.value = el.scrollHeight;
    clientHeight.value = el.clientHeight;
  }

  let ro: ResizeObserver | null = null;
  let observedChild: Element | null = null;

  function detach(el: HTMLElement): void {
    el.removeEventListener("scroll", onScroll);
    ro?.disconnect();
    ro = null;
    observedChild = null;
  }

  function onScroll(): void {
    snapshot();
  }

  function attach(el: HTMLElement): void {
    el.addEventListener("scroll", onScroll, { passive: true });
    ro = new ResizeObserver(() => snapshot());
    ro.observe(el);
    // Content height changes (rows added/removed) trigger scrollHeight to
    // change without firing a scroll event — observe the first child too so
    // the scrollbar thumb resizes as the list grows.
    observedChild = el.firstElementChild;
    if (observedChild) ro.observe(observedChild);
    snapshot();
  }

  watch(
    target,
    (next, prev) => {
      if (prev) detach(prev);
      if (next) attach(next);
    },
    { immediate: true, flush: "post" },
  );

  onBeforeUnmount(() => {
    const el = target.value;
    if (el) detach(el);
  });

  const position = computed(() => scrollTop.value);
  const viewportSize = computed(() => clientHeight.value);
  const range = computed(() => Math.max(0, scrollHeight.value - clientHeight.value));

  function onScrollTo(pos: number): void {
    const el = target.value;
    if (!el) return;
    el.scrollTop = Math.max(0, Math.min(range.value, pos));
  }

  function onPageBy(dir: -1 | 1): void {
    onScrollTo(scrollTop.value + dir * clientHeight.value);
  }

  return { position, range, viewportSize, onScrollTo, onPageBy };
}
