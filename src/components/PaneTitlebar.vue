<script setup lang="ts">
// The pane "titlebar": a centered grip hint at the top of a pane that reveals
// a pill (title + actions) on hover. The pill doubles as the drag handle for
// rearranging panes in a workspace. Shared by every pane type (terminal, file
// browser, git, …) so the chrome is identical everywhere; the per-type buttons
// (and close) are supplied by the parent through the `actions` slot, styled
// with `.pane-close`. Set `draggable` for workspace panes (emits `bardown` for
// the rearrange drag); standalone tabs leave it off.
withDefaults(defineProps<{ title: string; draggable?: boolean }>(), {
  draggable: false,
});
const emit = defineEmits<{ bardown: [MouseEvent] }>();

function onBarDown(e: MouseEvent): void {
  emit("bardown", e);
}
</script>

<template>
  <div class="pane-hover">
    <div class="pane-grip">⋯</div>
    <div
      class="pane-pill"
      :class="{ 'pane-pill-drag': draggable }"
      :title="title"
      @mousedown="draggable ? onBarDown($event) : undefined"
    >
      <span class="pane-title">{{ title }}</span>
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
/* Hover header: a centered grip hint + pill at the top of a pane. Only the
   small grip captures the pointer; the rest of the top row stays interactive
   for the pane beneath. The pill is hit-testable only once revealed
   (visibility gates pointer events), so it never steals clicks from the first
   terminal row. */
/* Span the full pane width (not just the pill) so the pill, centered inside,
   is bounded by the pane: a narrow pane clamps it (`.pane-pill` max-width:100%)
   instead of letting it overflow into an adjacent panel — which sits above at a
   higher z-index and would cover it — or past the window edge. */
.pane-hover {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 20;
  display: flex;
  justify-content: center;
  padding: 4px 8px 6px;
  pointer-events: none;
}
.pane-grip {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  padding: 2px 14px 4px;
  pointer-events: auto;
  user-select: none;
  font-size: 16px;
  line-height: 1;
  letter-spacing: 2px;
  color: var(--fg-subtle, #9399b2);
  opacity: 0.6;
  transition:
    opacity 140ms ease,
    transform 140ms ease;
}
.pane-hover:hover .pane-grip,
.pane-hover:active .pane-grip {
  /* Fade out in step with the pill dropping in, nudging down with it. */
  opacity: 0;
  transform: translateX(-50%) translateY(3px);
  transition-delay: 300ms;
}
.pane-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  /* Never wider than the pane (minus the hover container's padding), so it
     stays clear of neighbours and the window edge; capped at 240px otherwise.
     `min-width: 0` lets it actually shrink to that cap (a flex item's default
     min-width is its content, which would otherwise burst the max-width on a
     narrow pane); `overflow: hidden` is the backstop that keeps the buttons /
     title inside the rounded pill rather than spilling out. */
  max-width: min(240px, 100%);
  min-width: 0;
  overflow: hidden;
  padding: 0 4px 0 12px;
  box-sizing: border-box;
  border-radius: 9999px;
  user-select: none;
  font-size: 11px;
  color: var(--fg-muted, #cdd6f4);
  background: color-mix(in srgb, var(--surface-3, #313244) 88%, transparent);
  border: 1px solid
    color-mix(
      in srgb,
      var(--border-strong, rgba(255, 255, 255, 0.18)) 60%,
      transparent
    );
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  /* Hit-testable once revealed, so hovering onto it keeps .pane-hover:hover
     alive and its buttons are clickable; while hidden, `visibility` (not
     this) disables hit-testing. */
  pointer-events: auto;
  opacity: 0;
  visibility: hidden; /* hidden also disables hit-testing, unlike opacity */
  /* Rest state sits slightly up and shrunk so revealing reads as a gentle
     drop-in; the leave transition slides it back without the hover delay. */
  transform: translateY(-5px) scale(0.96);
  transition:
    opacity 120ms ease,
    transform 140ms ease,
    visibility 0s linear 140ms;
}
.pane-hover:hover .pane-pill,
.pane-hover:active .pane-pill {
  opacity: 1;
  visibility: visible;
  transform: translateY(0) scale(1);
  /* deliberate-hover delay: brushing past the grip never flashes the pill;
     the slightly overshooting ease gives the drop-in a soft settle. */
  transition:
    opacity 160ms ease 300ms,
    transform 220ms cubic-bezier(0.34, 1.4, 0.64, 1) 300ms,
    visibility 0s linear 300ms;
}
.pane-pill-drag {
  cursor: grab;
}
.pane-pill-drag:active {
  cursor: grabbing;
}
.pane-title {
  flex: 1;
  /* Allow the title to shrink below its content so it ellipsizes instead of
     shoving the action buttons out of the pill. */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Action buttons live in the parent's slot content (parent scope), but the
   close-style button is common enough to style here for slotted nodes too. */
:slotted(.pane-close) {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  color: var(--fg-subtle, #9399b2);
  cursor: pointer;
}
:slotted(.pane-close:hover) {
  color: var(--fg, #e6e6e6);
  background: color-mix(in srgb, var(--fg, #fff) 14%, transparent);
}
</style>
