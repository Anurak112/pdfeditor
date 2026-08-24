<script lang="ts">
  /**
   * One <svg> for every tool icon.
   *
   * Path data lives on the tool definition, so an icon is a property of the
   * tool rather than a separate asset to keep in sync — and nothing loads a
   * font or reaches the network to draw a glyph.
   */
  interface Props {
    path: string;
    size?: number;
    strokeWidth?: number;
  }
  let { path, size = 22, strokeWidth = 1.6 }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d={path} />
</svg>
