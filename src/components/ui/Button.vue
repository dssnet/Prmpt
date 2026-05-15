<script setup lang="ts">
import { computed } from "vue";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "link";
type Size = "md" | "sm";

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    size?: Size;
    icon?: any;
    iconSize?: number;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    title?: string;
  }>(),
  { variant: "primary", size: "md", type: "button" },
);

const sizeClasses: Record<Size, string> = {
  md: "px-3 py-1.5 text-xs gap-1 rounded-md",
  sm: "px-2.5 py-1 text-xs gap-1 rounded-md",
};

const variantClasses = computed<string>(() => {
  if (props.variant === "link") {
    return "bg-transparent border-0 text-accent text-xs underline cursor-pointer p-0 disabled:opacity-50";
  }
  if (props.variant === "ghost") {
    return "self-start bg-transparent border-0 text-fg-muted hover:bg-surface-1 hover:text-fg text-xs px-2 py-1 rounded-md cursor-pointer transition-colors duration-150";
  }
  if (props.variant === "primary") {
    return "border border-accent bg-accent text-bg hover:opacity-90 disabled:opacity-50 disabled:cursor-default cursor-pointer transition-opacity duration-150";
  }
  if (props.variant === "secondary") {
    return "border border-border-strong bg-transparent text-fg hover:bg-surface-2 hover:border-border-strong disabled:opacity-50 disabled:cursor-default cursor-pointer transition-colors duration-150";
  }
  // danger
  if (props.size === "sm") {
    return "border border-border bg-transparent text-fg-muted hover:bg-[color-mix(in_srgb,var(--color-danger)_30%,transparent)] hover:border-danger hover:text-fg disabled:opacity-50 disabled:cursor-default cursor-pointer transition-colors duration-150";
  }
  return "border border-danger bg-danger text-bg hover:opacity-90 disabled:opacity-50 disabled:cursor-default cursor-pointer transition-opacity duration-150";
});

const className = computed(() =>
  props.variant === "link" || props.variant === "ghost"
    ? variantClasses.value
    : `inline-flex items-center justify-center ${sizeClasses[props.size]} ${variantClasses.value}`,
);

const resolvedIconSize = computed(() => props.iconSize ?? (props.size === "sm" ? 14 : 16));
</script>

<template>
  <button
    :type="type"
    :class="className"
    :disabled="disabled"
    :title="title"
  >
    <component v-if="icon" :is="icon" :size="resolvedIconSize" />
    <slot />
  </button>
</template>
