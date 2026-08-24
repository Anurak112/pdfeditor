<script lang="ts">
  /**
   * Which build am I looking at?
   *
   * A version the user can see prevents the most wasteful kind of confusion:
   * testing an old bundle and reporting bugs that were already fixed. The dev
   * marker matters just as much — dev server and the single file look identical.
   */
  const version = __APP_VERSION__;
  const built = __BUILD_DATE__;
  const isDev = import.meta.env.DEV;
</script>

<span class="version-badge" title={isDev ? 'เปิดจาก dev server — แก้โค้ดแล้วเห็นผลทันที' : `สร้างเมื่อ ${built}`}>
  v{version}
  {#if isDev}<span class="dev">dev</span>{/if}
</span>

<style>
  .version-badge {
    font-family: var(--mono);
    font-size: var(--fs-1);
    color: var(--text-faint);
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }
  .dev {
    font-weight: 700;
    color: var(--warn);
    background: var(--warn-soft);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-1);
  }
</style>
