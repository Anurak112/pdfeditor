<script lang="ts">
  /**
   * One screen for every tool.
   *
   * Left is the material — the files, and later the page grid. Right is the
   * settings for whichever tool is open, and the button that acts on them. No
   * tool gets its own layout, so adding a tool is adding an options panel, not
   * a page.
   */
  import DropZone from '../components/DropZone.svelte';
  import ErrorPanel from '../components/ErrorPanel.svelte';
  import FileList from '../components/FileList.svelte';
  import LaneBadge from '../components/LaneBadge.svelte';
  import PageGrid from '../components/PageGrid.svelte';
  import PageView from '../components/PageView.svelte';
  import ProgressPanel from '../components/ProgressPanel.svelte';
  import ResultPanel from '../components/ResultPanel.svelte';
  import RunBar from '../components/RunBar.svelte';
  import { prefs } from '../prefs.svelte';
  import { router } from '../router.svelte';
  import { session } from '../session.svelte';
  import type { AnyTool } from '../../tools/types';
  import type { RecoveryAction } from '../../engine/errors';

  interface Props {
    tool: AnyTool;
  }
  let { tool }: Props = $props();

  const acceptsImages = $derived(tool.acceptedInputs.some((m) => m.startsWith('image/')));
  const showGridSlot = $derived(tool.ui.needsPageGrid && session.files.length > 0);

  // Adopt the tool now, during init, so the options panel below always finds a
  // selected tool. Reading the initial value is the point: Shell keys this
  // component on tool.id, so a different tool means a fresh instance and this
  // line runs again. Reacting to later changes of `tool` would be wrong here.
  // svelte-ignore state_referenced_locally
  if (session.toolId !== tool.id) session.selectTool(tool.id);

  // Capitalised so Svelte renders it as a component rather than an element.
  const OptionsPanel = $derived(tool.ui.optionsComponent);

  /**
   * Page selection lives in the tool's own options under `pages`.
   *
   * One home for it, so the grid, the prediction line and the engine cannot
   * disagree — the same reason Merge has no separate `order` field.
   */
  const selectedPages = $derived(
    new Set<number>(((session.options as { pages?: number[] } | null)?.pages ?? []) as number[]),
  );

  function setSelectedPages(next: Set<number>) {
    session.setOptions({ pages: [...next].sort((a, b) => a - b) });
  }

  // ---- organize -----------------------------------------------------------

  const organizing = $derived(tool.ui.pageGridMode === 'organize');
  const organizeOpts = $derived(
    session.options as { order?: number[]; rotations?: Record<number, number>; deleted?: number[] } | null,
  );

  function rotatePage(index: number, delta: 90 | -90) {
    const rotations = { ...(organizeOpts?.rotations ?? {}) };
    rotations[index] = (((rotations[index] ?? 0) + delta) % 360 + 360) % 360;
    session.setOptions({ rotations });
  }

  /** Delete is a toggle, so a mis-click costs one more click and nothing else. */
  function toggleDeleted(index: number) {
    const deleted = new Set(organizeOpts?.deleted ?? []);
    if (deleted.has(index)) deleted.delete(index);
    else deleted.add(index);
    session.setOptions({ deleted: [...deleted].sort((a, b) => a - b) });
  }

  function setOrder(order: number[]) {
    session.setOptions({ order });
  }

  /**
   * Grid or one page.
   *
   * Not two routes: the selection, the options and the loaded document are the
   * same either way, and a URL for "looking closely" would be a second place
   * for that state to live.
   */
  let view = $state<'grid' | 'page'>('grid');
  let viewIndex = $state(0);

  function openPage(index: number) {
    viewIndex = index;
    view = 'page';
  }

  let moreInput = $state<HTMLInputElement | undefined>();
  function addMore() {
    moreInput?.click();
  }

  /**
   * On a phone, follow the work.
   *
   * The panel is a sidebar on a wide screen and always in view. Stacked under
   * the page grid it is not: a run finishes, the result appears two screens
   * down, and the screen the user is looking at does not change at all. So when
   * a run ends on a narrow layout, the panel is brought to them.
   */
  let panelEl = $state<HTMLElement | undefined>();
  $effect(() => {
    if (session.stage !== 'done' && session.stage !== 'failed') return;
    if (typeof matchMedia !== 'function' || matchMedia('(min-width: 1024px)').matches) return;

    const panel = panelEl;
    if (!panel) return;
    // Already looking at it — moving the page under someone for no reason is
    // worse than not moving it.
    if (panel.getBoundingClientRect().top < innerHeight * 0.6) return;

    // Not 'smooth'. Smooth scrolling is animated by the compositor, and in a
    // tab that is throttled or not painting it does not fall back to jumping —
    // it does nothing at all, silently, which is how this was written the first
    // time and why the result stayed off screen. An instant scroll to a defined
    // destination always happens.
    panel.scrollIntoView({ behavior: 'auto', block: 'start' });
  });

  function onErrorAction(action: RecoveryAction) {
    if (action.kind === 'goto-tool' && action.toolId) {
      session.selectTool(action.toolId);
      router.openTool(action.toolId);
    } else if (action.kind === 'go-home') {
      router.home();
    } else if (action.kind === 'retry') {
      session.clearResult();
      session.run();
    } else if (action.kind === 'pick-file') {
      session.reset();
    } else {
      session.clearResult();
      session.dismissNotices();
    }
  }
</script>

<div class="workspace" class:has-runbar={session.stage !== 'running' && session.stage !== 'done'}>
  <!-- left: the material -->
  <div class="stage">
    {#if session.files.length === 0}
      <div class="empty">
        <DropZone
          variant="hero"
          acceptImages={acceptsImages}
          busy={session.stage === 'loading'}
          onfiles={(files) => session.addFiles(files)}
        />
      </div>
    {:else}
      <div class="stage-head">
        <span class="count tnum">
          {prefs.formatNumber(session.files.length)}
          {session.files.length === 1 ? prefs.t('file') : prefs.t('files')}
          {#if session.totalPages > 0}
            · {prefs.formatNumber(session.totalPages)} {prefs.t('pages')}
          {/if}
        </span>
        {#if session.files.length < tool.maxFiles}
          <button class="ghost tiny" onclick={() => addMore()}>+ {prefs.t('addFiles')}</button>
        {/if}
      </div>

      {#if showGridSlot && session.thumbs}
        {#if session.thumbs.failed}
          <div class="slot">
            <p class="slot-title">{prefs.t('thumbsFailed')}</p>
            <p class="slot-body">{prefs.t('thumbsFailedHint')}</p>
          </div>
        {/if}

        {#if view === 'page'}
          <PageView
            renderer={session.thumbs}
            index={viewIndex}
            onindex={(next) => (viewIndex = next)}
            onclose={() => (view = 'grid')}
          />
        {:else}
          <p class="grid-hint">{prefs.t('gridHint')}</p>
          <PageGrid
            thumbs={session.thumbs.thumbs}
            selected={organizing ? new Set() : selectedPages}
            onselect={organizing ? () => {} : setSelectedPages}
            onopen={openPage}
            onwant={(indices) => session.thumbs?.want(indices)}
            order={organizing ? (organizeOpts?.order ?? []) : undefined}
            rotations={organizing ? (organizeOpts?.rotations ?? {}) : undefined}
            deleted={organizing ? new Set(organizeOpts?.deleted ?? []) : undefined}
            onrotate={organizing ? rotatePage : undefined}
            ondelete={organizing ? toggleDeleted : undefined}
            onreorder={organizing ? setOrder : undefined}
          />
        {/if}
      {/if}

      <FileList
        files={session.files}
        reorderable={tool.maxFiles > 1}
        onremove={(id) => session.removeFile(id)}
        onmove={(id, dir) => session.moveFile(id, dir)}
      />

      <input
        class="sr-only"
        type="file"
        multiple
        accept={acceptsImages ? 'application/pdf,.pdf,image/jpeg,image/png' : 'application/pdf,.pdf'}
        bind:this={moreInput}
        onchange={(e) => {
          const el = e.currentTarget as HTMLInputElement;
          session.addFiles([...(el.files ?? [])]);
          el.value = '';
        }}
      />
    {/if}
  </div>

  <!-- right: the settings and the button -->
  <aside class="panel" bind:this={panelEl}>
    <div class="panel-head">
      <h2>{prefs.pick(tool.name)}</h2>
      <LaneBadge lane={tool.lane} />
    </div>
    <p class="blurb">{prefs.pick(tool.blurb)}</p>

    <div class="panel-body">
      {#if session.stage === 'running'}
        <ProgressPanel progress={session.progress} oncancel={() => session.cancel()} />
      {:else if session.stage === 'done'}
        <ResultPanel
          outputs={session.outputs}
          stats={session.stats}
          warnings={session.warnings}
          currentToolId={tool.id}
          onchain={async (id) => {
            // Measure first, then navigate. Reversed, the next tool renders
            // against the previous tool's files for a frame.
            await session.chainTo(id);
            router.openTool(id);
          }}
          onreset={() => {
            session.reset();
            router.home();
          }}
        />
      {:else}
        {#if session.error}
          <ErrorPanel error={session.error} onaction={onErrorAction} />
        {/if}

        {#each session.notices as notice (notice.code + prefs.pick(notice.message))}
          <ErrorPanel error={notice} onaction={onErrorAction} />
        {/each}

        {#if OptionsPanel}
          <OptionsPanel />
        {:else}
          <div class="options">
            <p class="options-title">{prefs.t('options')}</p>
            <p class="options-body">{prefs.t('optionsComing')}</p>
            <p class="options-hint">{prefs.t('optionsComingHint')}</p>
          </div>
        {/if}
      {/if}
    </div>

    {#if session.stage !== 'running' && session.stage !== 'done'}
      <RunBar
        label={prefs.pick(tool.name)}
        prediction={session.prediction}
        blockedReason={session.blockedReason}
        notBuilt={session.toolNotBuilt}
        disabled={!session.canRun}
        onrun={() => session.run()}
      />
    {/if}
  </aside>
</div>

<style>
  .workspace {
    display: grid;
    gap: var(--space-5);
    max-width: 1200px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5) var(--space-8);
    align-items: start;
  }

  /*
   * Room for the run bar, which pins itself to the bottom edge below this
   * breakpoint. Only while it is actually on screen — after a run it unmounts,
   * and reserving space for something that is not there is just a hole.
   */
  @media (max-width: 1023px) {
    .workspace.has-runbar { padding-bottom: 132px; }
  }

  @media (min-width: 1024px) {
    .workspace { grid-template-columns: minmax(0, 1fr) 340px; }
  }
  @media (min-width: 1280px) {
    .workspace { grid-template-columns: minmax(0, 1fr) 360px; }
  }

  .stage {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .empty { padding: var(--space-5) 0; }

  .stage-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .count { font-size: var(--fs-1); color: var(--text-muted); }
  .tiny { padding: var(--space-1) var(--space-3); font-size: var(--fs-1); }

  .slot {
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
    padding: var(--space-7) var(--space-5);
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .slot-title { margin: 0; font-weight: 600; font-size: var(--fs-2); color: var(--text); }
  .grid-hint { margin: 0; font-size: var(--fs-1); color: var(--text-faint); }
  .slot-body { margin: 0; font-size: var(--fs-2); color: var(--text-muted); max-width: 50ch; align-self: center; }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
  }
  @media (min-width: 1024px) {
    .panel { position: sticky; top: var(--space-5); }
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .panel-head h2 { font-size: var(--fs-3); }

  .blurb { margin: 0; font-size: var(--fs-2); color: var(--text-muted); line-height: 1.55; }

  .panel-body { display: flex; flex-direction: column; gap: var(--space-3); }

  .options {
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .options-title {
    margin: 0;
    font-size: var(--fs-1);
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .options-body { margin: 0; font-size: var(--fs-2); color: var(--text); font-weight: 500; }
  .options-hint { margin: 0; font-size: var(--fs-1); color: var(--text-muted); line-height: 1.55; }

  @media (max-width: 1023px) {
    .workspace { padding: var(--space-4) var(--space-4) var(--space-7); }
  }
</style>
